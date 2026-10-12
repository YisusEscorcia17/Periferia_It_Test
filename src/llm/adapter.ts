export interface LlamadaTool {
  id: string
  name: string
  args: Record<string, unknown>
}

export type Mensaje =
  | { role: "user" | "assistant"; content: string }
  | { role: "assistant"; content: string; toolCalls: LlamadaTool[] }
  | { role: "tool"; toolCallId: string; name: string; content: string }

export interface DefinicionTool {
  name: string
  description: string
  parameters: Record<string, unknown>
}

export interface ValorAfirmado {
  campo: string
  valor: string
}

export interface RespuestaLLM {
  text?: string
  toolCalls?: LlamadaTool[]
  valores?: ValorAfirmado[]
  usage?: { entrada: number; salida: number }
}

export interface Adaptador {
  nombre: string
  modelo: string
  enviar(mensajes: Mensaje[], tools: DefinicionTool[], sistema?: string): Promise<RespuestaLLM>
}
