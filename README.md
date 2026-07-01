# ChismeNet

Aplicación de chat en tiempo real con salas grupales, mensajes privados, reacciones con emoji y panel de administración, construida como proyecto académico para la asignatura de **Aplicaciones Distribuidas**.

**Demo en vivo:** [chismenet.onrender.com](https://chismenet.onrender.com/chat.html)

---

## Contenido

- [Descripción](#-descripción)
- [Características](#-características)
- [Tecnologías](#-tecnologías)
- [Arquitectura](#-arquitectura)
- [Instalación local](#-instalación-local)
- [Estructura del proyecto](#-estructura-del-proyecto)
- [Seguridad implementada](#-seguridad-implementada)
- [Despliegue](#-despliegue)
- [Autores](#-autores)

---

## Descripción

**ChismeNet** es una aplicación web de mensajería en tiempo real inspirada en la interfaz de WhatsApp. Permite a los usuarios registrarse, conversar en salas grupales públicas o personalizadas, enviar mensajes privados con confirmación de lectura, reaccionar con emojis y, para los administradores, gestionar usuarios y salas desde un panel dedicado.

## Características

**Chat y mensajería**
- Salas grupales públicas (General, Tecnología, Random) y salas personalizadas creadas por los usuarios
- Mensajes privados uno a uno
- Historial de mensajes persistente
- Indicador de "escribiendo..." en tiempo real
- Reacciones con emoji (toggle) en mensajes de sala y privados
- Estados de mensaje estilo WhatsApp: enviado (✓), entregado (✓✓ gris) y leído (✓✓ azul)
- Estado de usuarios en línea/desconectado en tiempo real
- Interfaz con sidebar doble (Chats / Salas)

**Perfil de usuario**
- Edición de nombre de usuario, contraseña y foto de perfil (avatar en base64)
- El renombrado de usuario actualiza automáticamente sus mensajes, salas creadas y reacciones

**Panel de administración**
- Configuración guiada del primer administrador (`setup-primer-admin`)
- Tabla de usuarios con rol, fecha de registro y estado de conexión
- Promover/degradar administradores y eliminar usuarios
- Crear y eliminar salas personalizadas
- Estadísticas en vivo (usuarios registrados, mensajes enviados, salas activas, conectados)

## Tecnologías

| Categoría | Tecnología |
|---|---|
| Backend | Node.js, Express |
| Tiempo real | Socket.io |
| Base de datos | SQLite (`better-sqlite3`) |
| Autenticación | `bcryptjs` (hash de contraseñas) |
| Identificadores | `uuid` |
| Frontend | HTML, CSS y JavaScript vanilla |

## Arquitectura

Arquitectura cliente-servidor con comunicación dual (HTTP/REST + WebSockets):

```
Cliente (navegador)
   │  HTTP/REST (login, registro, perfil, admin)
   │  WebSocket (mensajes, escritura, reacciones, presencia)
   ▼
Servidor (Node.js + Express + Socket.io)
   │  Middleware de autenticación (header x-admin-user para rutas admin)
   │  bcryptjs para contraseñas
   ▼
Base de datos (SQLite / better-sqlite3)
   users · rooms · messages · reactions
```

## Instalación local

**Requisitos:** Node.js 20.x (ver `.nvmrc` / `engines` en `package.json` — `better-sqlite3` no compila de forma confiable con Node 24+)

```bash
# 1. Clonar el repositorio
git clone https://github.com/Arianaalomia/chismenet-chat.git
cd chismenet-chat

# 2. Instalar dependencias
npm install

# 3. Iniciar el servidor
npm start
# o: node server.js
```

El servidor arrancará en `http://localhost:3000`. Al entrar por primera vez, regístrate como usuario y luego usa el flujo de **configuración del primer administrador** para obtener acceso al panel `/admin`.

## Estructura del proyecto

```
chismenet-chat/
├── server.js          # Servidor Express + Socket.io + rutas + lógica de negocio
├── index.html          # Login / registro
├── chat.html            # Interfaz principal de chat
├── admin.html            # Panel de administración
├── package.json
├── .nvmrc                 # Versión de Node fijada (20.18.1)
├── .gitignore             # Excluye node_modules/, chat.db, .env
└── chat.db                # Base de datos SQLite (generada al ejecutar, no versionada)
```

## Seguridad implementada

- Contraseñas hasheadas con `bcryptjs` (nunca en texto plano)
- Bloqueo temporal tras varios intentos fallidos de login (normal y de administrador)
- Validación de formato de nombre de usuario (`3-20 caracteres, solo letras, números, '.' y '_'`) tanto en cliente como en servidor
- Validación estricta del avatar en el servidor: debe ser un data URI de imagen en base64 válido, previniendo inyección de HTML/JS (XSS almacenado)
- Protección contra quedarse sin ningún administrador en el sistema (no se puede eliminar ni degradar al último admin)
- Verificación de existencia de usuario antes de promover/degradar
- Mensajes de error genéricos en login normal para evitar enumeración de usuarios

## Despliegue

Desplegado en **Render** (plan gratuito), configurado con:

| Campo | Valor |
|---|---|
| Build Command | `npm install` |
| Start Command | `node server.js` |
| Variables de entorno | Ninguna requerida (usa `process.env.PORT` que Render inyecta automáticamente) |
