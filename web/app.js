(() => {
  const sessionId = globalThis.crypto?.randomUUID?.() ?? `s-${Date.now()}-${Math.random().toString(36).slice(2)}`
  const $ = (s) => document.querySelector(s)
  const historial = $("#historial")
  const dialogo = $("#confirmacion")
  const bienvenida = $("#bienvenida")
  let pendiente = null

  // Casos del reto (fixtures/reto-01/casos). El texto se inserta siempre con textContent (anti-XSS).
  const CASOS = [
    { id: "pa-logistica-istmo", formato: "Portal", pais: "Panamá" },
    { id: "ec-corp-andina", formato: "PDF", pais: "Ecuador" },
    { id: "co-industrias-delta", formato: "Excel", pais: "Colombia" },
    { id: "hn-agroexport-sula", formato: "Excel", pais: "Honduras" },
  ]

  const mensajeParaCaso = (caso) =>
    `Procesa el caso ${caso}. Dime qué campos quedaron llenos, cuáles faltan y si el paquete está listo para firma. No envíes nada todavía.`

  const ocultarBienvenida = () => bienvenida.classList.add("oculta")

  const burbuja = (rol, texto, extra = "") => {
    const d = document.createElement("div")
    d.className = `msg ${rol} ${extra}`.trim()
    d.textContent = texto
    historial.append(d)
    historial.scrollTop = historial.scrollHeight
  }

  const llamadaHerramienta = (t) => {
    const d = document.createElement("details")
    d.className = `tool${t.ok ? "" : " error"}`
    const s = document.createElement("summary")
    s.textContent = `${t.ok ? "✓" : "✕"} ${t.name.replace(/^proveedor_/, "")}`
    const p = document.createElement("pre")
    p.textContent = `Argumentos: ${JSON.stringify(t.args)}\nResultado: ${t.resumen}`
    d.append(s, p)
    historial.append(d)
  }

  // Enlaces para descargar los archivos generados (formulario, valores del portal, paquete).
  const enlacesDeDescarga = (descargas) => {
    const caja = document.createElement("div")
    caja.className = "descargas"
    const titulo = document.createElement("span")
    titulo.textContent = "Archivos generados:"
    caja.append(titulo)
    for (const d of descargas) {
      const enlace = document.createElement("a")
      enlace.href = d.url
      enlace.download = d.nombre.replace(/^paquete\//, "")
      enlace.textContent = d.nombre
      caja.append(enlace)
    }
    historial.append(caja)
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
      for (const t of r.toolCalls ?? []) llamadaHerramienta(t)
      burbuja("assistant", r.reply, r.needsConfirmation ? "confirmacion" : "")
      if (r.descargas?.length) enlacesDeDescarga(r.descargas)
      if (r.needsConfirmation && r.actionId) {
        pendiente = { actionId: r.actionId, resuelto: false }
        $("#conf-detalle").textContent = `¿Simular el envío del caso ${r.caso} al portal del cliente?`
        dialogo.showModal()
      }
    } catch {
      burbuja("assistant", "No hay respuesta del servidor. Revisa la conexión e inténtalo de nuevo.")
    } finally {
      $("#pensando").hidden = true
    }
  }

  const resolver = (confirmed) => {
    if (!pendiente || pendiente.resuelto) return
    const { actionId } = pendiente
    pendiente.resuelto = true
    if (dialogo.open) dialogo.close()
    if (!confirmed) burbuja("assistant", "Envío cancelado. No se creó ningún archivo.")
    llamar({ confirmed, actionId })
  }

  const enviarMensaje = (texto) => {
    ocultarBienvenida()
    burbuja("user", texto)
    llamar({ message: texto })
  }

  // Tarjetas de casos: botones con listener (sin atributos en línea, por la CSP).
  const contenedorCasos = $("#casos")
  for (const caso of CASOS) {
    const boton = document.createElement("button")
    boton.type = "button"
    boton.className = "caso"
    const nombre = document.createElement("strong")
    nombre.textContent = caso.id
    const detalle = document.createElement("span")
    detalle.textContent = `${caso.pais} · formato ${caso.formato}`
    boton.append(nombre, detalle)
    boton.addEventListener("click", () => enviarMensaje(mensajeParaCaso(caso.id)))
    contenedorCasos.append(boton)
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
    enviarMensaje(texto)
  })

  fetch("/api/health")
    .then((r) => r.json())
    .then((h) => {
      $("#estado").textContent = `Conectado · ${h.model}`
    })
    .catch(() => {
      $("#estado").textContent = "Sin conexión"
    })
})()
