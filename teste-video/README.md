# Transmissão de vídeo local P2P (WebRTC)

Sistema minimalista de transmissão de vídeo local em tempo real via navegador. Um usuário seleciona um arquivo de vídeo do sistema de arquivos e transmite para múltiplos espectadores com arquitetura Peer-to-Peer (WebRTC).

## Arquitetura

1. **Servidor de sinalização (Node.js + Socket.IO)**  
   Troca apenas metadados de conexão (SDP e candidatos ICE). A mídia **não** passa pelo servidor.

2. **Cliente (HTML5 + WebRTC)**  
   Usa `HTMLMediaElement.captureStream()` para transformar o playback de um arquivo local em `MediaStream`, e cria uma `RTCPeerConnection` por espectador (mesh 1-para-N).

## Estrutura

```text
teste-video/
├── server.js
├── package.json
└── public/
    ├── index.html
    └── app.js
```

## Como executar

```bash
cd teste-video
npm install
npm start
```

Abra http://localhost:3002

1. **Aba 1 (transmissor):** Escolher arquivo → Iniciar transmissão  
2. **Aba 2 (espectador):** abrir a mesma URL — o vídeo deve tocar automaticamente

## Limitações

- STUN público do Google; redes com NAT simétrico podem precisar de TURN  
- Topologia mesh: upload do transmissor cresce com o número de espectadores  
- `captureStream()` depende do codec/container suportado pelo navegador
