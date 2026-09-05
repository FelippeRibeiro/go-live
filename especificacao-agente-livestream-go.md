# Especificação de Projeto: Servidor Mini-Livestream em Go (Pion WebRTC SFU)

Este documento define as especificações técnicas, regras de arquitetura, fluxo de aplicação e diretrizes de implementação para um **Agente de IA / Desenvolvedor** construir do zero o projeto **Mini LiveStream Go**.

---

## 1. Visão Geral do Projeto

O **Mini LiveStream Go** é uma aplicação em Go de baixa latência (sub-segundo) para criação de salas virtuais, compartilhamento de tela e transmissão ao vivo de áudio e vídeo em tempo real. 

### Objetivos Principais
* **Multiplataforma:** Compilação e execução nativa em Linux e Windows (sem dependências C / `CGO_ENABLED=0`).
* **Interface Web Nativa:** Clientes acessam via navegador sem instalar softwares ou extensões externas.
* **Arquitetura SFU (Selective Forwarding Unit):** O transmissor envia o fluxo de mídia **uma única vez** para o servidor em Go, que faz o roteamento dos pacotes RTP para múltiplos espectadores.
* **Gerenciamento de Salas:** Criação de salas dinâmicas com IDs únicos e suporte opcional a senha de acesso.

---

## 2. Tecnologias e Dependências

### Backend (Go)
* **Linguagem:** Go 1.21+
* **WebRTC Engine:** `github.com/pion/webrtc/v3` (100% Go nativo)
* **Sinalização (WebSockets):** `github.com/gorilla/websocket`
* **Servidor HTTP:** Módulo nativo `net/http`

### Frontend (Web Client)
* **Tecnologias:** HTML5, CSS3, JavaScript nativo (Vanilla JS ES6+)
* **Captura de Mídia:** API do navegador `navigator.mediaDevices.getDisplayMedia()`
* **Comunicação WebRTC:** API nativa `RTCPeerConnection`
* **Conexão em Tempo Real:** API nativa `WebSocket`

---

## 3. Arquitetura da Aplicação e Fluxo de Dados

```text
[ Transmissor (Browser) ]
       │  (WebSocket: Criar Sala, Senha, SDP Offer/Answer, ICE)
       ▼
[ Servidor Go (Pion SFU + WebSocket Server) ]
       │  (WebSockets: Autenticação, SDP Offer/Answer, ICE)
       │  (WebRTC UDP/RTP Track - 1x Stream In)
       ├───────────────────────────────┐
       ▼                               ▼
[ Espectador 1 (Browser) ]      [ Espectador 2 (Browser) ]
```

### Fluxo do Usuário:
1. **Criação de Sala:**
   * O usuário acessa a página inicial e escolhe "Criar Sala".
   * Informa um nome e uma senha opcional.
   * O backend gera um `room_id` único e retorna para o usuário.

2. **Entrada na Sala:**
   * **Transmissor (Host):** Conecta à sala via WebSocket como `publisher`.
   * **Espectador (Guest):** Conecta à sala via WebSocket como `subscriber` (informa a senha se houver).

3. **Início da Transmissão (Publisher):**
   * O transmissor clica em "Compartilhar Tela".
   * O navegador solicita permissão usando `getDisplayMedia({ video: true, audio: true })`.
   * Uma oferta SDP (SDP Offer) é gerada e enviada via WebSocket para o servidor Go.
   * O Pion WebRTC no servidor processa a oferta, registra as tracks de áudio/vídeo e responde com uma SDP Answer.

4. **Distribuição do Vídeo (SFU):**
   * À medida que pacotes RTP chegam do transmissor, o Pion replica os pacotes para todos os `subscribers` ativos na mesma sala.
   * Quando um novo espectador entra, o servidor cria uma `RTCPeerConnection` de saída para ele e anexa as `TrackLocalStaticRTP` da sala.

---

## 4. Regras e Requisitos do Agente

O Agente que implementar o código deve seguir obrigatoriamente as seguintes diretrizes:

### 4.1. Regras de Código Go (Backend)
1. **CGO Disabled:** Todo o projeto deve ser compilado com `CGO_ENABLED=0` para garantir portabilidade entre Linux e Windows.
2. **Gerenciamento de Estado Concorrente:** O mapa global de salas (`map[string]*Room`) **deve** ser protegido usando `sync.RWMutex` para evitar *data races*.
3. **Gerenciamento de Memória & Disconnects:** Quando o `publisher` desconectar, a sala deve encerrar as tracks locais e notificar todos os `subscribers` via WebSocket.
4. **Log Estruturado:** Todos os eventos de conexão, desconexão, envio de oferta/resposta SDP e falha de autenticação de senha devem ter mensagens claras via biblioteca `log`.

### 4.2. Regras de Frontend e WebRTC
1. **Sem Frameworks CSS/JS Pesados:** Implementar tudo em um único arquivo HTML/JS ou pastas estáticas simples (`public/index.html`, `public/app.js`).
2. **Tratamento de Mídia:** O player do espectador (`<video>`) deve conter as propriedades `autoplay`, `playsinline` e suporte a `controls`.
3. **Lógica ICE Candidate:** O fluxo de sinalização deve repassar os `ICECandidates` gerados no frontend para o backend Pion e vice-versa.

### 4.3. Regras de Segurança Básicas
1. **Verificação de Senha:** O backend não deve expor a mídia do transmissor nem trocar negociações SDP com espectadores que falharem na validação da senha.
2. **Sanitização de Input:** IDs de sala devem ser higienizados (apenas alfanuméricos e hífens).

---

## 5. Estrutura de Arquivos Recomendada

```text
mini-livestream/
├── go.mod
├── go.sum
├── main.go
├── pkg/
│   ├── room/
│   │   ├── manager.go       # Gerenciamento de salas, senhas e estado
│   │   └── room.go          # Estrutura da Sala e Pion SFU Tracks
│   └── signaling/
│       ├── client.go        # Abstração de cliente WebSocket
│       └── handler.go       # Handlers de sinalização SDP e ICE
└── public/
    ├── index.html           # Dashboard de criação/entrada de sala
    ├── room.html            # Interface da transmissão/visualização
    ├── css/
    │   └── style.css
    └── js/
        ├── app.js           # Lógica da interface
        └── webrtc.js        # Lógica de conexão WebRTC e WebSocket
```

---

## 6. Protocolo de Sinalização WebSocket (JSON)

As mensagens trocadas no WebSocket devem seguir o seguinte formato genérico em JSON:

### Exemplo 1: Entrar na Sala
```json
{
  "action": "join",
  "room_id": "a1b2-c3d4",
  "password": "minhasenhasegura",
  "role": "subscriber"
}
```

### Exemplo 2: Troca de Oferta SDP (Publisher -> Server)
```json
{
  "action": "offer",
  "sdp": "v=0
o=- 123456 2 IN IP4...",
  "type": "offer"
}
```

### Exemplo 3: Resposta SDP (Server -> Publisher/Subscriber)
```json
{
  "action": "answer",
  "sdp": "v=0
o=- 654321 2 IN IP4...",
  "type": "answer"
}
```

### Exemplo 4: Troca de ICE Candidate
```json
{
  "action": "candidate",
  "candidate": {
    "candidate": "candidate:842163049 1 udp...",
    "sdpMid": "0",
    "sdpMLineIndex": 0
  }
}
```

---

## 7. Critérios de Aceite para o Agente

* [ ] **Compilação:** Executar `go build` no Windows e Linux gera o executável sem erros.
* [ ] **Criação de Sala:** Iniciar o servidor e criar uma sala pública e uma sala protegida por senha via interface Web.
* [ ] **Transmissão:** Transmitir a tela com áudio em um navegador Chrome/Firefox/Edge.
* [ ] **Visualização:** Abrir 2 ou mais abas/navegadores como espectador e visualizar o vídeo da tela com latência < 1 segundo.
* [ ] **Resiliência:** Ao fechar a aba do transmissor, a transmissão deve ser limpa no servidor e os espectadores notificados.
