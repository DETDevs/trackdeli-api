import * as fs from 'fs';
import * as path from 'path';

/**
 * Strips single-line (//) and multi-line (/* *\/) comments from JavaScript / TypeScript code,
 * safely preserving single-quoted, double-quoted, and template literal strings.
 */
export function stripComments(sourceText: string): string {
  let hasComments = false;
  const regex =
    /("(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|`(?:\\[\s\S]|[^`\\])*`)|(\/\/[^\r\n]*|\/\*[\s\S]*?\*\/)/g;

  const stripped = sourceText.replace(regex, (match, stringLiteral, comment) => {
    if (stringLiteral) {
      return stringLiteral;
    }
    hasComments = true;
    return '';
  });

  if (!hasComments) {
    return sourceText;
  }

  const lines = stripped.split(/\r?\n/);
  const cleanedLines: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const trimmedRight = lines[i].replace(/[ \t]+$/, '');
    const isCurrentEmpty = trimmedRight.trim() === '';
    const isPrevEmpty =
      cleanedLines.length > 0 && cleanedLines[cleanedLines.length - 1].trim() === '';

    if (isCurrentEmpty && isPrevEmpty) {
      continue;
    }
    cleanedLines.push(trimmedRight);
  }

  while (cleanedLines.length > 0 && cleanedLines[0].trim() === '') {
    cleanedLines.shift();
  }

  return cleanedLines.join('\n') + (sourceText.endsWith('\n') ? '\n' : '');
}

function processPath(targetPath: string, dryRun: boolean, stats: { filesCount: number; linesReduced: number }) {
  const resolved = path.resolve(targetPath);
  if (!fs.existsSync(resolved)) {
    console.warn(`[WARN] Ruta no encontrada: ${targetPath}`);
    return;
  }

  const stat = fs.statSync(resolved);
  if (stat.isDirectory()) {
    const entries = fs.readdirSync(resolved);
    for (const entry of entries) {
      if (['node_modules', 'dist', '.git', '.next'].includes(entry)) continue;
      processPath(path.join(resolved, entry), dryRun, stats);
    }
  } else if (stat.isFile()) {
    const ext = path.extname(resolved).toLowerCase();
    if (!['.ts', '.tsx', '.js', '.jsx'].includes(ext)) return;

    const original = fs.readFileSync(resolved, 'utf-8');
    const cleaned = stripComments(original);

    if (original !== cleaned) {
      const origLines = original.split('\n').length;
      const cleanLines = cleaned.split('\n').length;
      const diff = origLines - cleanLines;

      if (!dryRun) {
        fs.writeFileSync(resolved, cleaned, 'utf-8');
        console.log(`✓ Limpiado: ${path.relative(process.cwd(), resolved)} (-${diff} líneas)`);
      } else {
        console.log(`[DRY-RUN] Cambios en: ${path.relative(process.cwd(), resolved)} (-${diff} líneas)`);
      }

      stats.filesCount++;
      stats.linesReduced += Math.max(0, diff);
    }
  }
}

function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const targetPaths = args.filter((a) => a !== '--dry-run');

  if (targetPaths.length === 0) {
    console.log(`
Uso del script para remover comentarios:
  npx ts-node scripts/strip-comments.ts <ruta1> <ruta2> ... [--dry-run]

Ejemplos:
  npx ts-node scripts/strip-comments.ts src/modules/pos/offline/offline.service.ts
  npx ts-node scripts/strip-comments.ts src/modules/pos/offline
  npx ts-node scripts/strip-comments.ts src/modules/pos/sales/sales.service.ts --dry-run
`);
    return;
  }

  const stats = { filesCount: 0, linesReduced: 0 };
  for (const p of targetPaths) {
    processPath(p, dryRun, stats);
  }

  console.log(`\nResumen: ${stats.filesCount} archivo(s) procesados. Líneas reducidas: ${stats.linesReduced}`);
}

if (require.main === module) {
  main();
}
