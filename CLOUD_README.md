# Differ IA Cloud

Servidor 24/7 para aprendizaje continuo de DIGIT DIFFER sobre R_75.

- Recibe ticks públicos de Deriv aunque el navegador esté cerrado.
- Mantiene el mismo tipo de aprendizaje online del proyecto web.
- Guarda memoria en `DATA_DIR/differ-ai-memory.json`.
- En Railway se recomienda montar un volumen persistente en `/data` y definir `DATA_DIR=/data`.
- No necesita PAT ni credenciales para aprender del mercado.
- Estado: `/api/cloud/status`
- Salud: `/health`
