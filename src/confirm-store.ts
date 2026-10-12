import { randomUUID } from "node:crypto"

interface Pendiente {
  sessionId: string
  accion: Record<string, unknown>
  turno: number
}

export class ConfirmStore {
  private pendientes = new Map<string, Pendiente>()

  emitir(sessionId: string, accion: Record<string, unknown>, turno: number): string {
    for (const [id, p] of this.pendientes) if (p.sessionId === sessionId) this.pendientes.delete(id)
    const id = randomUUID()
    this.pendientes.set(id, { sessionId, accion, turno })
    return id
  }

  consumir(sessionId: string, actionId: string, turno: number): Record<string, unknown> | null {
    const p = this.pendientes.get(actionId)
    if (!p || p.sessionId !== sessionId) return null
    this.pendientes.delete(actionId)
    return turno === p.turno + 1 ? p.accion : null
  }
}
