# Security / Seguridad

**English.** If you find a vulnerability, please do not open a public issue. Use GitHub's private reporting instead: *Security → Report a vulnerability* in this repository. Include the steps to reproduce it. Never include your own keys, passwords or Worker URL in a report.

**Español.** Si encuentras una vulnerabilidad, no abras un issue público. Usa el aviso privado de GitHub: *Security → Report a vulnerability* en este repositorio, con los pasos para reproducirla. No incluyas nunca tus claves, contraseñas ni la URL de tu Worker.

If you think one of your secrets leaked / Si crees que se ha filtrado una clave:

1. Rotate it at its source: Tuya (cloud project / proyecto cloud), Supabase (*API Keys*), or choose a new dashboard password. / Cámbiala en su origen.
2. `npx wrangler secret put <NAME>` with the new value, then `npx wrangler deploy`. / Guarda el nuevo valor y vuelve a desplegar.
