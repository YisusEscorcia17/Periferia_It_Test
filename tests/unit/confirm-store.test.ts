import { describe, expect, it } from "vitest"
import { ConfirmStore } from "../../src/confirm-store.js"

describe("ConfirmStore", () => {
  it("el actionId es de un solo uso", () => {
    const s = new ConfirmStore()
    const id = s.emitir("s1", { caso: "a" }, 1)
    expect(s.consumir("s1", id, 2)).toEqual({ caso: "a" })
    expect(s.consumir("s1", id, 2)).toBeNull()
  })

  it("rechaza actionId viejo, ajeno o desconocido", () => {
    const s = new ConfirmStore()
    const viejo = s.emitir("s1", { caso: "a" }, 1)
    s.emitir("s1", { caso: "a" }, 3)
    expect(s.consumir("s1", viejo, 4)).toBeNull()
    expect(s.consumir("s1", "nope", 4)).toBeNull()
    const otro = s.emitir("s2", { caso: "b" }, 1)
    expect(s.consumir("s1", otro, 2)).toBeNull()
  })

  it("expira si no se confirma en el turno N+1", () => {
    const s = new ConfirmStore()
    const id = s.emitir("s1", { caso: "a" }, 1)
    expect(s.consumir("s1", id, 3)).toBeNull()
  })
})
