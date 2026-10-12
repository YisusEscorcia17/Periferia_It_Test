import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import type { IFileSystem } from "./BaseTool.js"

// Implementación real de IFileSystem sobre node:fs.
export class FsNode implements IFileSystem {
  leer(ruta: string): string {
    return readFileSync(ruta, "utf8")
  }

  existe(ruta: string): boolean {
    return existsSync(ruta)
  }

  escribir(ruta: string, contenido: string): void {
    mkdirSync(dirname(ruta), { recursive: true })
    writeFileSync(ruta, contenido, "utf8")
  }

  escribirBinario(ruta: string, datos: Uint8Array): void {
    mkdirSync(dirname(ruta), { recursive: true })
    writeFileSync(ruta, datos)
  }

  copiar(origen: string, destino: string): void {
    mkdirSync(dirname(destino), { recursive: true })
    copyFileSync(origen, destino)
  }

  listar(ruta: string): string[] {
    return readdirSync(ruta)
  }

  borrar(ruta: string): void {
    rmSync(ruta, { recursive: true, force: true })
  }
}
