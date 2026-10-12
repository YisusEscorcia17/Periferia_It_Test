import { isAbsolute, relative, resolve } from "node:path"

// Resuelve rutas de casos dentro de una raíz fija. Lanza si el resultado sale de esa raíz.
export class PathResolver {
  private readonly raiz: string

  constructor(raiz: string) {
    this.raiz = resolve(raiz)
  }

  caso(caso: string): string {
    const destino = resolve(this.raiz, caso)
    const rel = relative(this.raiz, destino)
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
      throw new Error(`ruta fuera de la raíz permitida: ${caso}`)
    }
    return destino
  }
}
