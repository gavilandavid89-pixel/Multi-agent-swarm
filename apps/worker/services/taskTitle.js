const MAX_TITLE_LENGTH = 64;

const conversationalPrefixes = [
  /^(?:bro|che)\b[\s,!:;—-]*/iu,
  /^(?:por favor|porfa)\b[\s,!:;—-]*/iu,
  /^(?:¿?podrías ayudarme a|¿?podrias ayudarme a|¿?podés ayudarme a|¿?podes ayudarme a|¿?puedes ayudarme a|ayúdame a|ayudame a|me ayudas a|quiero que|necesito que)\s+/iu,
  /^(?:¿?podrías|¿?podrias|¿?podés|¿?podes|¿?puedes|hazme|haceme)\s+/iu
];

export function generateTaskTitle(objective) {
  const original = String(objective || '')
    .replace(/[\u0000-\u001f\u007f]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  if (!original) return 'Nueva tarea';

  const firstSentence = original.match(/^.{1,800}?(?:[.!?](?=\s|$)|$)/u)?.[0] || original;
  let title = firstSentence
    .replace(/[.!?…]+$/u, '')
    .replace(/^[\s"'“”‘’`#>*-]+|[\s"'“”‘’`]+$/gu, '')
    .trim();

  for (let pass = 0; pass < 3; pass += 1) {
    const previous = title;
    for (const prefix of conversationalPrefixes) title = title.replace(prefix, '').trim();
    if (title === previous) break;
  }

  if (!title) title = firstSentence.replace(/[.!?…]+$/u, '').trim() || original;
  const chars = [...title];
  title = chars[0].toLocaleUpperCase('es') + chars.slice(1).join('');

  if ([...title].length > MAX_TITLE_LENGTH) {
    const shortened = [...title].slice(0, MAX_TITLE_LENGTH - 1).join('');
    const boundary = shortened.lastIndexOf(' ');
    title = (boundary >= 40 ? shortened.slice(0, boundary) : shortened).trimEnd() + '…';
  }
  return title || 'Nueva tarea';
}
