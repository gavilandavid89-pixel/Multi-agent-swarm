import { spawn } from 'node:child_process';

export async function checkJavascriptSyntax(delivery) {
  const source = String(delivery);
  const blocks = [...source.matchAll(/```(?:javascript|js|mjs|cjs)\s*\n([\s\S]*?)```/gi)];
  if (blocks.length === 0) return { checked: false, ok: true, message: 'No se encontraron bloques JavaScript delimitados; la entrega solo recibió revisión de IA.' };
  for (let index = 0; index < blocks.length; index += 1) {
    const result = await new Promise(resolve => {
      const child = spawn(process.execPath, ['--check'], { stdio: ['pipe', 'ignore', 'pipe'] });
      let stderr = '';
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', chunk => { if (stderr.length < 12000) stderr += chunk; });
      child.on('error', error => resolve({ ok: false, error: error.message }));
      child.on('close', code => resolve({ ok: code === 0, error: stderr.trim() }));
      child.stdin.end(blocks[index][1]);
    });
    if (!result.ok) return { checked: true, ok: false, message: `El bloque JavaScript ${index + 1} no supera node --check: ${(result.error || 'error de sintaxis').slice(0, 2000)}` };
  }
  return { checked: true, ok: true, message: `node --check validó ${blocks.length} bloque(s) JavaScript sin ejecutarlos.` };
}
