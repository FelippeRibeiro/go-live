# Mini LiveStream Go

Servidor SFU WebRTC em Go (Pion) com salas virtuais, compartilhamento de tela e espectadores no navegador.

## Requisitos

- Go 1.21+
- Navegador com WebRTC (`getDisplayMedia`) — Chrome, Firefox ou Edge

## Docker

```bash
docker compose up --build -d
```

Abra http://localhost:8080

O compose usa `network_mode: host` (Linux) para o WebRTC/UDP funcionar corretamente.

```bash
docker compose down
```

## Build

```bash
CGO_ENABLED=0 go build -o go-live .
```

O binário é portátil (Linux/Windows) sem CGO.

## Executar

```bash
CGO_ENABLED=0 go run .
# ou
./go-live
```

Abra http://localhost:8080

Porta customizada:

```bash
PORT=9090 ./go-live
```

## Como testar

1. Em uma aba, **Criar sala** (com ou sem senha) e clique em **Compartilhar tela**.
2. Em outras abas/navegadores, **Entrar como espectador** com o ID da sala (e senha, se houver).
3. Feche a aba do host — os espectadores recebem o fim da transmissão.

## Estrutura

```text
main.go                 # HTTP + estáticos + /api/rooms + /ws
pkg/room/               # Manager (RWMutex) + Room SFU
pkg/signaling/          # WebSocket client + handlers SDP/ICE
public/                 # HTML/CSS/JS vanilla
```

## Dependências

- [`github.com/pion/webrtc/v3`](https://github.com/pion/webrtc) — WebRTC em Go puro
- [`github.com/gorilla/websocket`](https://github.com/gorilla/websocket) — sinalização

## Protocolo WebSocket (resumo)

| action | uso |
|--------|-----|
| `join` | entrar como `publisher` ou `subscriber` |
| `offer` / `answer` | troca SDP |
| `candidate` | ICE |
| `ended` / `error` | servidor → cliente |

Detalhes completos em [especificacao-agente-livestream-go.md](especificacao-agente-livestream-go.md).
