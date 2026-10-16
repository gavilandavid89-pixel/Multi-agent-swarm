import test from 'node:test';
import assert from 'node:assert/strict';
import { generateTaskTitle } from '../apps/worker/services/taskTitle.js';

test('genera automáticamente un título breve a partir del primer mensaje', () => {
  assert.equal(
    generateTaskTitle('Crear una aplicación para organizar mis tareas. Después agregá inicio de sesión.'),
    'Crear una aplicación para organizar mis tareas'
  );
});

test('limpia saludos y preámbulos conversacionales sin exigir un título manual', () => {
  assert.equal(
    generateTaskTitle('Bro, ¿podés ayudarme a crear una página para mi negocio?'),
    'Crear una página para mi negocio'
  );
});

test('normaliza saltos de línea y limita títulos largos a 64 caracteres', () => {
  const title = generateTaskTitle('Implementar\nuna plataforma muy completa con múltiples agentes, historial, autenticación, permisos, archivos y ejecución de pruebas automáticas');
  assert.ok([...title].length <= 64);
  assert.ok(!/[\r\n]/u.test(title));
  assert.ok(title.endsWith('…'));
});

test('usa un título de respaldo si el objetivo está vacío', () => {
  assert.equal(generateTaskTitle('  \n  '), 'Nueva tarea');
});
