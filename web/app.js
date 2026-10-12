(() => {
  const sessionId = crypto.randomUUID()
  const $ = (s) => document.querySelector(s)
  const historial = $("#historial")
  const dialogo = $("#confirmacion")
  let pendiente = null

  const burbuja = (rol, texto, extra = "") => {
    const d = document.createElement("div")
    d.className = `msg ${rol} ${extra}`.trim()
    d.textContent = texto
    historial.append(d)
    historial.scrollTop = historial.scrollHeight
  }

  const toolCall = (t) => {
    const d = document.createElement("details")
    d.className = `tool${t.ok ? "" : " error"}`
    const s = document.createElement("summary")
    s.textContent = `${t.ok ? "🔧" : "⚠️"} ${t.name}`
    const p = document.createElement("pre")
    p.textContent = `${JSON.stringify(t.args)}\n${t.resumen}`
    d.append(s, p)
    historial.append(d)
  }

  async function llamar(cuerpo) {
    $("#pensando").hidden = false
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId, ...cuerpo }),
      })
      if (!res.ok) throw new Error(String(res.status))
      const r = await res.json()
      for (const t of r.toolCalls ?? []) toolCall(t)
      burbuja("assistant", r.reply, r.needsConfirmation ? "confirmacion" : "")
      if (r.needsConfirmation && r.actionId) {
        pendiente = { actionId: r.actionId, resuelto: false }
        $("#conf-detalle").textContent = `¿Enviar el caso ${r.caso} al portal del cliente (simulado)?`
        dialogo.showModal()
      }
    } catch {
      burbuja("assistant", "No pude comunicarme con el servidor. Intenta de nuevo.")
    } finally {
      $("#pensando").hidden = true
    }
  }

  const resolver = (confirmed) => {
    if (!pendiente || pendiente.resuelto) return
    const { actionId } = pendiente
    pendiente.resuelto = true
    if (dialogo.open) dialogo.close()
    if (!confirmed) burbuja("assistant", "Envío cancelado.")
    llamar({ confirmed, actionId })
  }

  $("#aceptar").addEventListener("click", () => resolver(true))
  $("#cancelar").addEventListener("click", () => resolver(false))
  dialogo.addEventListener("cancel", () => resolver(false))

  $("#form").addEventListener("submit", (e) => {
    e.preventDefault()
    const input = $("#mensaje")
    const texto = input.value.trim()
    if (!texto) return
    input.value = ""
    burbuja("user", texto)
    llamar({ message: texto })
  })

  fetch("/api/health").then((r) => r.json()).then((h) => { $("#estado").textContent = `${h.provider} · ${h.model}` }).catch(() => {})
})()
