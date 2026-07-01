const express  = require("express");
const http  = require("http");
const { Server } = require("socket.io");
const bcrypt = require("bcryptjs");
const { v4: uuidv4 } = require("uuid");
const path = require("path");
const Database = require("better-sqlite3");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// base de datos local
const db = new Database("chat.db");

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    is_admin  INTEGER DEFAULT 0,
    last_seen TEXT DEFAULT (datetime('now')),
    created_at  TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS rooms (
    id  TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    icon  TEXT DEFAULT '💬',
    created_by TEXT,
    is_default INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS messages (
    id  TEXT PRIMARY KEY,
    username  TEXT NOT NULL,
    room  TEXT,
    to_user TEXT,
    message TEXT NOT NULL,
    is_private INTEGER DEFAULT 0,
    status TEXT DEFAULT 'enviado',
    timestamp  TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS reactions (
    id  TEXT PRIMARY KEY,
    message_id TEXT NOT NULL,
    username  TEXT NOT NULL,
    emoji  TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(message_id, username, emoji)
  );

  INSERT OR IGNORE INTO rooms (id, name, icon, is_default) VALUES
    ('general', '# General', '💬', 1),
    ('tecnologia', '# Tecnología', '💻', 1),
    ('random', '# Random',  '🎲', 1);
`);

try {
  db.exec("ALTER TABLE users ADD COLUMN avatar TEXT");
} catch (e) {
  // ya existe la columna, no pasa nada
}

const qInsertUser = db.prepare("INSERT INTO users (id, username, password) VALUES (?, ?, ?)");
const qFindUser = db.prepare("SELECT * FROM users WHERE username = ?");
const qAllUsers = db.prepare("SELECT id, username, is_admin, created_at, last_seen FROM users ORDER BY created_at DESC");
const qDelUser = db.prepare("DELETE FROM users WHERE username = ?");const qSetAdmin      = db.prepare("UPDATE users SET is_admin = ? WHERE username = ?");
const qActualizarVisto = db.prepare("UPDATE users SET last_seen = datetime('now') WHERE username = ?");
const qAllRooms = db.prepare("SELECT * FROM rooms ORDER BY is_default DESC, created_at ASC");
const qInsertRoom = db.prepare("INSERT INTO rooms (id, name, icon, created_by) VALUES (?, ?, ?, ?)");
const qDelRoom = db.prepare("DELETE FROM rooms WHERE id = ? AND is_default = 0");
const qFindRoom = db.prepare("SELECT * FROM rooms WHERE id = ?");
const qInsertMsg = db.prepare("INSERT INTO messages (id, username, room, to_user, message, is_private, status, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
const qMsgsByRoom = db.prepare("SELECT * FROM (SELECT * FROM messages WHERE room = ? AND is_private = 0 ORDER BY created_at DESC LIMIT 50) ORDER BY created_at ASC");
const qMsgStats = db.prepare("SELECT COUNT(*) as total FROM messages WHERE is_private = 0");
const qPrivateMsgs = db.prepare(`
  SELECT * FROM (
    SELECT * FROM messages
    WHERE is_private = 1
    AND ((username = ? AND to_user = ?) OR (username = ? AND to_user = ?))
    ORDER BY created_at DESC LIMIT 50
  ) ORDER BY created_at ASC
`);
const qUltimosPrivados = db.prepare(`
  SELECT * FROM messages
  WHERE is_private = 1 AND (username = ? OR to_user = ?)
  ORDER BY created_at DESC
`);

const qMarcarLeido = db.prepare("UPDATE messages SET status = 'leido' WHERE username = ? AND to_user = ? AND status != 'leido'");
const qInsertReact = db.prepare("INSERT OR IGNORE INTO reactions (id, message_id, username, emoji) VALUES (?, ?, ?, ?)");
const qDelReact = db.prepare("DELETE FROM reactions WHERE message_id = ? AND username = ? AND emoji = ?");
const qGetReacts = db.prepare("SELECT emoji, COUNT(*) as count, GROUP_CONCAT(username) as users FROM reactions WHERE message_id = ? GROUP BY emoji");
const qFindReact = db.prepare("SELECT * FROM reactions WHERE message_id = ? AND username = ? AND emoji = ?");

const qUpdateAvatar = db.prepare("UPDATE users SET avatar = ? WHERE username = ?");
const qUpdatePassword  = db.prepare("UPDATE users SET password = ? WHERE username = ?");
const qUpdateUsername = db.prepare("UPDATE users SET username = ? WHERE username = ?");
const qRenameMsgsUser = db.prepare("UPDATE messages SET username = ? WHERE username = ?");
const qRenameMsgsTo = db.prepare("UPDATE messages SET to_user = ? WHERE to_user = ?");
const qRenameRoomsCreator = db.prepare("UPDATE rooms SET created_by = ? WHERE created_by = ?");
const qRenameReactions = db.prepare("UPDATE reactions SET username = ? WHERE username = ?");

app.use(express.static(path.join(__dirname, "public")));
app.use(express.json({ limit: "5mb" }));

// bloqueo temporal por intentos fallidos
const intentosFallidos = {};

function verificarBloqueo(uname) {
  const ahora = Date.now();
  const reg   = intentosFallidos[uname];
  if (!reg) return { ok: true };
  if (ahora - reg.ultimo > 30000) { delete intentosFallidos[uname]; return { ok: true }; }
  if (reg.veces >= 3) {
    const espera = Math.ceil((30000 - (ahora - reg.ultimo)) / 1000);
    return { ok: false, espera };
  }
  return { ok: true };
}

function registrarFallo(uname) {
  const ahora = Date.now();
  if (!intentosFallidos[uname]) {
    intentosFallidos[uname] = { veces: 1, ultimo: ahora };
  } else {
    intentosFallidos[uname].veces++;
    intentosFallidos[uname].ultimo = ahora;
  }
}

const conectados = {};

function estaEnLinea(uname) {
  return Object.values(conectados).some(u => u.username === uname);
}

function usernameValido(u) {
  return typeof u === "string" && /^[a-zA-Z0-9_.]{3,20}$/.test(u);
}

function obtenerAvatar(username) {
  const u = qFindUser.get(username);
  return u ? u.avatar || null : null;
}

function avatarValido(a) {
  if (a === null || a === undefined) return true;
  if (typeof a !== "string") return false;
  if (a.length > 2_200_000) return false; // ~1.6MB de imagen en base64
  return /^data:image\/(png|jpe?g|gif|webp);base64,[A-Za-z0-9+/=]+$/.test(a);
}

function esUltimoAdmin(username) {
  const admins = qAllUsers.all().filter(u => u.is_admin === 1);
  return admins.length === 1 && admins[0].username === username;
}

// rutas publicas
app.get("/rooms", (req, res) => res.json(qAllRooms.all()));

app.post("/register", async (req, res) => {
  const username = (req.body.username || "").trim();
  const password = req.body.password;
  if (!username || !password)
    return res.status(400).json({ error: "Faltan datos" });
   if (!usernameValido(username))
    return res.status(400).json({ error: "Usuario: 3-20 caracteres, solo letras, números, '.' y '_'" });
  if (password.length < 4)
    return res.status(400).json({ error: "Contraseña muy corta, mínimo 4 caracteres" });
  if (qFindUser.get(username))
    return res.status(409).json({ error: "Ese usuario ya existe" });

  try {
    const hash = await bcrypt.hash(password, 10);
    qInsertUser.run(uuidv4(), username, hash);
    res.json({ ok: true });
  } catch (e) {
    console.error("fallo al registrar:", e);
    res.status(500).json({ error: "No se pudo crear la cuenta" });
  }
});

app.post("/login", async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password)
    return res.status(400).json({ error: "Faltan datos" });

  const bloqueo = verificarBloqueo(username);
  if (!bloqueo.ok)
    return res.status(429).json({ error: `Demasiados intentos. Espera ${bloqueo.espera}s` });

  const u = qFindUser.get(username);
  if (!u) {
    registrarFallo(username);
    return res.status(401).json({ error: "Usuario o contraseña incorrectos" });
  }

  const coincide = await bcrypt.compare(password, u.password);
  if (!coincide) {
    registrarFallo(username);
    return res.status(401).json({ error: "Usuario o contraseña incorrectos" });
  }

  delete intentosFallidos[username];
  qActualizarVisto.run(username);
  res.json({ ok: true, username, isAdmin: u.is_admin === 1 });
});

// acceso al panel — requiere clave extra
const CLAVE_ADMIN = "chismenet2026admin";

app.post("/admin-login", async (req, res) => {
  
  const { username, password, secret } = req.body;
  if (!username || !password || !secret)
    return res.status(400).json({ error: "Faltan datos" });

  const bloqueo = verificarBloqueo("admin_" + username);
  if (!bloqueo.ok)
    return res.status(429).json({ error: `Demasiados intentos. Espera ${bloqueo.espera}s` });

  if (secret !== CLAVE_ADMIN) {
    registrarFallo("admin_" + username);
    return res.status(403).json({ error: "Clave incorrecta" });
  }

  const u = qFindUser.get(username);
  if (!u) { registrarFallo("admin_" + username); return res.status(401).json({ error: "Usuario no encontrado" }); }

  const coincide = await bcrypt.compare(password, u.password);
  if (!coincide) { registrarFallo("admin_" + username); return res.status(401).json({ error: "Contraseña incorrecta" }); }
  if (u.is_admin !== 1)
    return res.status(403).json({ error: "Sin permisos de administrador" });

  delete intentosFallidos["admin_" + username];
  res.json({ ok: true, username });
});

// Crear el primer admin, solo si no existe ningun administrador
app.post("/setup-primer-admin", (req, res) => {
  const { username, secret } = req.body;
  if (secret !== CLAVE_ADMIN)
    return res.status(403).json({ error: "Clave incorrecta" });

  const yaHayAdmin = qAllUsers.all().some(u => u.is_admin === 1);
  if (yaHayAdmin)
    return res.status(403).json({ error: "Ya existe un administrador, pídele que te promueva desde el panel" });

  const u = qFindUser.get(username);
  if (!u) return res.status(404).json({ error: "Ese usuario no existe, regístrate primero" });

  qSetAdmin.run(1, username);
  res.json({ ok: true });
});

app.get("/contactos/:username", (req, res) => {
  const yo = req.params.username;
  const mensajes = qUltimosPrivados.all(yo, yo);

  const conversaciones = {};
  for (const m of mensajes) {
    const otro = m.username === yo ? m.to_user : m.username;
    if (!conversaciones[otro]) {
      conversaciones[otro] = {
        username: otro,
        avatar: obtenerAvatar(otro),
        ultimoMensaje: m.message,
        hora: m.timestamp,
        esMio: m.username === yo,
        leido: m.status === "leido",
        enLinea: estaEnLinea(otro),
      };
    }
  }

  res.json(Object.values(conversaciones));
});

app.get("/profile/:username", (req, res) => {
  const u = qFindUser.get(req.params.username);
  if (!u) return res.status(404).json({ error: "Usuario no encontrado" });
  res.json({ username: u.username, avatar: u.avatar || null, is_admin: u.is_admin === 1 });
});

app.put("/profile/:username", async (req, res) => {
  const actual = req.params.username;
  const { newUsername, newPassword, avatar } = req.body;

  const u = qFindUser.get(actual);
  if (!u) return res.status(404).json({ error: "Usuario no encontrado" });

  let usernameFinal = actual;

  if (newUsername && newUsername.trim() !== actual) {
    const limpio = newUsername.trim();
    if (!usernameValido(limpio))
      return res.status(400).json({ error: "Usuario: 3-20 caracteres, solo letras, números, '.' y '_'" });
    if (qFindUser.get(limpio))
      return res.status(409).json({ error: "Ese nombre de usuario ya existe" });

    const renombrar = db.transaction(() => {
      qUpdateUsername.run(limpio, actual);
      qRenameMsgsUser.run(limpio, actual);
      qRenameMsgsTo.run(limpio, actual);
      qRenameRoomsCreator.run(limpio, actual);
      qRenameReactions.run(limpio, actual);
    });
    renombrar();
    usernameFinal = limpio;
  }

  if (newPassword) {
    if (newPassword.length < 4)
      return res.status(400).json({ error: "Contraseña muy corta, mínimo 4 caracteres" });
    const hash = await bcrypt.hash(newPassword, 10);
    qUpdatePassword.run(hash, usernameFinal);
  }

  if (avatar !== undefined) {
    if (!avatarValido(avatar))
      return res.status(400).json({ error: "Formato de imagen inválido" });
    qUpdateAvatar.run(avatar, usernameFinal);
  }

  res.json({ ok: true, username: usernameFinal });
});

// middleware para rutas protegidas
function soloAdmin(req, res, next) {
  const quien = req.headers["x-admin-user"];
  if (!quien) return res.status(401).json({ error: "No autorizado" });
  const u = qFindUser.get(quien);
  if (!u || u.is_admin !== 1) return res.status(403).json({ error: "Acceso denegado" });
  next();
}

app.get("/admin", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "admin.html"));
});

app.get("/admin/stats", soloAdmin, (req, res) => {
  const usuarios  = qAllUsers.all();
  const msgs = qMsgStats.get();
  const salas = qAllRooms.all();
  const enLinea = Object.values(conectados).map(u => u.username);
  res.json({
    totalUsers: usuarios.length,
    totalMessages: msgs.total,
    totalRooms: salas.length,
    onlineNow: enLinea.length,
    users: usuarios,
    rooms: salas,
    onlineUsers: enLinea,
  });
});

app.delete("/admin/users/:username", soloAdmin, (req, res) => {
  const quien = req.headers["x-admin-user"];
  const objetivo = req.params.username;
  if (quien === objetivo)
    return res.status(400).json({ error: "No puedes eliminar tu propia cuenta" });
  const u = qFindUser.get(objetivo);
  if (!u) return res.status(404).json({ error: "Usuario no encontrado" });
  if (u.is_admin === 1 && esUltimoAdmin(objetivo))
    return res.status(400).json({ error: "No puedes eliminar al único administrador del sistema" });
  qDelUser.run(objetivo);
  res.json({ ok: true });
});

app.post("/admin/promote/:username", soloAdmin, (req, res) => {
  const u = qFindUser.get(req.params.username);
  if (!u) return res.status(404).json({ error: "Usuario no encontrado" });
  qSetAdmin.run(1, req.params.username);
  res.json({ ok: true });
});

app.post("/admin/demote/:username", soloAdmin, (req, res) => {
  const quien = req.headers["x-admin-user"];
  const objetivo = req.params.username;
  if (quien === objetivo)
    return res.status(400).json({ error: "No puedes quitarte tus propios permisos de admin" });
  const u = qFindUser.get(objetivo);
  if (!u) return res.status(404).json({ error: "Usuario no encontrado" });
  if (esUltimoAdmin(objetivo))
    return res.status(400).json({ error: "No puedes quitarle el rol al único administrador del sistema" });
  qSetAdmin.run(0, objetivo);
  res.json({ ok: true });
});

app.delete("/admin/rooms/:roomId", soloAdmin, (req, res) => {
  qDelRoom.run(req.params.roomId);
  io.emit("room_deleted", req.params.roomId);
  res.json({ ok: true });
});

// sockets
io.on("connection", (socket) => {
  console.log("+ conectado:", socket.id);

  socket.on("join", ({ username, room }) => {
  const anterior = conectados[socket.id];
  if (anterior) {
    socket.leave(anterior.room);
    io.to(anterior.room).emit("system_message", `${username} cambió de sala`);
  }
  const avatar = obtenerAvatar(username);
  conectados[socket.id] = { username, room, avatar };
  socket.join(room);
  socket.join("usuario_" + username);

  const hist = qMsgsByRoom.all(room).map(m => ({ ...m, avatar: obtenerAvatar(m.username), reactions: qGetReacts.all(m.id) }));
  socket.emit("message_history", hist);
  io.to(room).emit("system_message", `${username} entró a la sala`);
  actualizarLista(room);
  avisarEstadoContacto(username, true);
});

  socket.on("change_room", ({ username, newRoom }) => {
  const anterior = conectados[socket.id];
  if (anterior) {
    socket.leave(anterior.room);
    io.to(anterior.room).emit("system_message", `${username} salió de la sala`);
    actualizarLista(anterior.room);
  }
  const avatar = obtenerAvatar(username);
  conectados[socket.id] = { username, room: newRoom, avatar };
  socket.join(newRoom);

  const hist = qMsgsByRoom.all(newRoom).map(m => ({ ...m, avatar: obtenerAvatar(m.username), reactions: qGetReacts.all(m.id) }));
  socket.emit("message_history", hist);
  io.to(newRoom).emit("system_message", `${username} entró a la sala`);
  actualizarLista(newRoom);
});

  socket.on("create_room", ({ username, roomName }) => {
    const nombre = roomName.trim();
    if (!nombre || nombre.length < 3 || nombre.length > 20) {
      socket.emit("room_error", "Nombre: entre 3 y 20 caracteres");
      return;
    }
    const id = nombre.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
    if (qFindRoom.get(id)) {
      socket.emit("room_error", "Ya existe esa sala");
      return;
    }
    qInsertRoom.run(id, "# " + nombre, "💬", username);
    io.emit("room_created", qFindRoom.get(id));
  });

  socket.on("send_message", ({ username, message, room }) => {
  const txt = message?.trim();
  if (!txt) return;

  const hora = new Date().toLocaleTimeString("es-EC", { hour: "2-digit", minute: "2-digit" });
  const avatar = obtenerAvatar(username);
  const msg  = { id: uuidv4(), username, room, to_user: null, message: txt, is_private: 0, timestamp: hora };

  qInsertMsg.run(msg.id, msg.username, msg.room, null, msg.message, 0, "enviado", msg.timestamp);
  io.to(room).emit("receive_message", { ...msg, avatar, reactions: [] });
});

  // mensaje privado
  socket.on("send_private", ({ from, to, message }) => {
  const txt = message?.trim();
  if (!txt) return;

  const hora = new Date().toLocaleTimeString("es-EC", { hour: "2-digit", minute: "2-digit" });
  const destinoConectado = estaEnLinea(to);
  const estadoInicial = destinoConectado ? "entregado" : "enviado";
  const avatar = obtenerAvatar(from);

  const msg = { id: uuidv4(), username: from, to_user: to, message: txt, is_private: 1, status: estadoInicial, timestamp: hora, avatar };

  qInsertMsg.run(msg.id, from, null, to, msg.message, 1, estadoInicial, hora);

  socket.emit("receive_private", msg);
  io.to("usuario_" + to).emit("receive_private", msg);

  if (destinoConectado) {
    socket.emit("private_status", { messageId: msg.id, status: "entregado" });
  }
});

  socket.on("marcar_leido", ({ yo, otro }) => {
    qMarcarLeido.run(otro, yo);
    io.to("usuario_" + otro).emit("mensajes_leidos", { por: yo });
  });

  socket.on("get_private_history", ({ user1, user2 }) => {
  const hist = qPrivateMsgs.all(user1, user2, user2, user1).map(m => ({ ...m, avatar: obtenerAvatar(m.username) }));
  socket.emit("private_history", { withUser: user2, messages: hist });
});

  socket.on("react", ({ messageId, username, emoji, room }) => {
    const yaReaccionó = qFindReact.get(messageId, username, emoji);
    if (yaReaccionó) {
      qDelReact.run(messageId, username, emoji);
    } else {
      qInsertReact.run(uuidv4(), messageId, username, emoji);
    }
    io.to(room).emit("reaction_update", { messageId, reactions: qGetReacts.all(messageId) });
  });

  socket.on("react_privado", ({ messageId, username, emoji, otroUsuario }) => {
    const yaReaccionó = qFindReact.get(messageId, username, emoji);
    if (yaReaccionó) {
      qDelReact.run(messageId, username, emoji);
    } else {
      qInsertReact.run(uuidv4(), messageId, username, emoji);
    }
    const reactions = qGetReacts.all(messageId);
    socket.emit("reaction_update_privado", { messageId, reactions });
    io.to("usuario_" + otroUsuario).emit("reaction_update_privado", { messageId, reactions });
  });

  socket.on("typing",({ username, room }) => { socket.to(room).emit("user_typing", username); });
  socket.on("stop_typing", ({ room }) => { socket.to(room).emit("user_stop_typing"); });

  // typing chat privado
  socket.on("typing_privado",({ from, to }) => { io.to("usuario_" + to).emit("user_typing_privado", from); });
  socket.on("stop_typing_privado", ({ to }) => { io.to("usuario_" + to).emit("user_stop_typing_privado"); });

  socket.on("pedir_usuarios_online", () => {
  const nombres = [...new Set(Object.values(conectados).map(u => u.username))];
  const todos = nombres.map(n => ({ username: n, avatar: obtenerAvatar(n) }));
  socket.emit("usuarios_online_lista", todos);
});

  socket.on("disconnect", () => {
    const u = conectados[socket.id];
    if (u) {
      delete conectados[socket.id];
      io.to(u.room).emit("system_message", `${u.username} abandonó el chat`);
      actualizarLista(u.room);
      qActualizarVisto.run(u.username);
      avisarEstadoContacto(u.username, false);
      console.log("- desconectado:", u.username);
    }
  });
});

function actualizarLista(room) {
  const lista = Object.values(conectados)
    .filter(u => u.room === room)
    .map(u => ({ username: u.username, avatar: u.avatar }));
  io.to(room).emit("user_list", lista);
}


function avisarEstadoContacto(username, online) {
  io.emit("contacto_estado", { username, online });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`servidor en http://localhost:${PORT}`));