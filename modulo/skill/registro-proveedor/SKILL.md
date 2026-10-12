---
name: registro-proveedor
description: Proceso de registro de proveedor de Periferia: herramientas, reglas RN1 a RN5 y confirmación para envíos.
---
# Proceso de registro de proveedor

## Casos disponibles

| Caso | Formato | País del cliente |
|---|---|---|
| `pa-logistica-istmo` | portal (valores copiables) | Panamá |
| `ec-corp-andina` | pdf | Ecuador |
| `co-industrias-delta` | xlsx | Colombia |
| `hn-agroexport-sula` | xlsx | Honduras |

## Quién es el proveedor

El proveedor que se registra es siempre **Periferia IT Group S.A.S.** (Colombia, NIT del maestro). Los clientes (`solicitud.cliente`: Logística del Istmo, Corporación Andina, etc.) son quienes piden el registro. Los campos del formulario describen a Periferia, no al cliente.

- El país de la solicitud (`solicitud.pais`) **no** es motivo para detener el proceso. Solo afecta a RN1 (identificador tributario) y al estado `requiere_confirmacion`.
- No compares la razón social, el país o los datos de contacto del maestro contra el cliente: esa comparación no aplica.
- Si una herramienta devuelve un dato, úsalo tal cual; si falta, es faltante.

## Herramientas

| Herramienta | Qué hace |
|---|---|
| `proveedor_leer_solicitud` | Lee la solicitud del caso: país, cliente, formato, campos y soportes exigidos. |
| `proveedor_mapear_campos` | Clasifica cada campo contra el glosario y el maestro. |
| `proveedor_generar_formulario` | Genera `valores-portal.md`. Otros formatos (xlsx, pdf) no están soportados. |
| `proveedor_armar_paquete` | Arma `paquete/` con checklist de soportes, copias de los vigentes y borrador de correo sin datos bancarios. |
| `proveedor_simular_envio` | Simula el envío. Sin confirmación explícita no crea nada. |

## Pasos

1. **Leer la solicitud** del caso (país, cliente, formato de portal requerido).
2. **Identificar el formato**: el caso de portal exige `valores-portal.md`; xlsx y pdf no están soportados todavía.
3. **Mapear campos** con el glosario y el maestro de proveedor; solo se usan valores presentes en las fuentes.
4. **Verificar soportes exigidos** contra el repositorio: cada soporte queda `presente`, `ausente` o `vencido` según su `vigencia_hasta` frente a la fecha de referencia.
5. **Reportar faltantes** (campos sin fuente, campos a confirmar o soportes ausentes/vencidos) antes de enviar. Un soporte vencido impide `listo_para_firma`.
6. **Solicitar el envío**: requiere confirmación humana explícita (Aceptar/Cancelar). Solo entonces se crea `ENVIO-SIMULADO.md` en `out/<caso>/`.

## Reglas de negocio

- **RN1 — identificador tributario por país.** CO → NIT, EC → RUC, PE → RUC, PA → RUC, HN → RTN. Para países distintos de Colombia, el campo se llena con el NIT del maestro y queda `requiere_confirmacion` con la nota "identificador extranjero". Nunca se bloquea por esto.
- **RN2 — borrador sin banco.** El borrador de correo nunca incluye número de cuenta, titular ni entidad bancaria.
- **RN4 — envío confirmado.** Ningún envío ocurre sin confirmación humana vigente.
- **RN5 — observabilidad.** Cada ejecución de herramienta deja una línea en `out/<caso>/log.jsonl`.

Regla de oro: un valor sin fuente en el maestro, los soportes o la solicitud es un faltante, no se inventa.
