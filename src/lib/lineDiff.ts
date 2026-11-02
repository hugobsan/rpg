/** Diferença por linhas (maior subsequência comum): "-" só em a, "+" só em b, " " nas duas. */
export function lineDiff(a: string, b: string): [" " | "-" | "+", string][] {
  const x = a.split("\n");
  const y = b.split("\n");
  const n = x.length;
  const m = y.length;
  // L[i][j] = tamanho da subsequência comum de x[i..] e y[j..]
  const L = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--) L[i][j] = x[i] === y[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out: [" " | "-" | "+", string][] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && x[i] === y[j]) out.push([" ", x[i++]]), j++;
    else if (i < n && (j === m || L[i + 1][j] >= L[i][j + 1])) out.push(["-", x[i++]]);
    else out.push(["+", y[j++]]);
  }
  return out;
}
