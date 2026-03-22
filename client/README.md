# Client (React + Vite)

This folder contains the React migration of the original chat.html frontend.

## Dev

- Install from repo root:
  - npm run install:all

One-command options:

- From repo root (runs backend + client dev server):
  - npm start

- From client folder (also runs backend + client dev server):
  - npm run dev

Frontend-only option (if backend is already running):

- cd client
- npm run dev:ui

Vite proxies /api/* and /auth/* to http://localhost:3000.

## Build

From repo root:

- npm run build:client

Build output is written to client/dist.

## Production static serving note (backend unchanged by this migration)

When you are ready to serve the React build from Express, add this line in orchestrator/src/index.js near other static middleware:

app.use(express.static("client/dist"));

And route fallback to index.html for client routes if needed.
