import './style.css'

const app = document.querySelector<HTMLDivElement>('#app')!

app.innerHTML = `
  <main>
    <h1>Go Config</h1>
    <p>Frontend Vite servido pela API Go em produção, com proxy para a API em desenvolvimento.</p>

    <div class="card">
      <h2>GET /health</h2>
      <pre id="health">carregando...</pre>
    </div>

    <div class="card">
      <h2>GET /api/users/1</h2>
      <pre id="user">carregando...</pre>
    </div>

    <button id="reload">Recarregar</button>
  </main>
`

async function fetchJSON(url: string): Promise<unknown> {
  const res = await fetch(url)
  if (!res.ok) {
    throw new Error(`${res.status} ${res.statusText}`)
  }
  return res.json()
}

async function loadData() {
  const healthEl = document.querySelector<HTMLPreElement>('#health')!
  const userEl = document.querySelector<HTMLPreElement>('#user')!

  try {
    const health = await fetchJSON('/health')
    healthEl.textContent = JSON.stringify(health, null, 2)
    healthEl.classList.remove('error')
  } catch (err) {
    healthEl.textContent = String(err)
    healthEl.classList.add('error')
  }

  try {
    const user = await fetchJSON('/api/users/1')
    userEl.textContent = JSON.stringify(user, null, 2)
    userEl.classList.remove('error')
  } catch (err) {
    userEl.textContent = String(err)
    userEl.classList.add('error')
  }
}

document.querySelector<HTMLButtonElement>('#reload')!.addEventListener('click', loadData)
loadData()
