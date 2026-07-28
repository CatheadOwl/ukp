export function countFlagOccurrences(args: readonly string[], flag: string): number {
  if (!flag.startsWith("-") || flag.startsWith("--") || flag.length !== 2) {
    return args.filter((argument) => argument === flag).length;
  }

  const shortFlag = flag[1];
  return args.reduce((count, argument) => {
    if (argument === flag) return count + 1;
    if (!argument.startsWith("-") || argument.length <= 2) return count;

    const bundle = argument.slice(1);
    if (!/^[A-Za-z]+$/.test(bundle)) return count;
    if (!bundle.split("").every((character) => character === shortFlag)) return count;
    return count + bundle.length;
  }, 0);
}
