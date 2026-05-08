import { checkDeps } from "../lib/deps.ts";
import { c } from "../lib/log.ts";

export async function doctorCommand(): Promise<number> {
  const deps = await checkDeps();
  process.stdout.write(c.bold("Dependency check\n"));

  let missingRequired = 0;
  for (const d of deps) {
    const tag = d.required ? c.dim(" (required)") : c.dim(" (optional)");
    if (d.available) {
      const ver = d.version ? c.dim(` ${d.version}`) : "";
      process.stdout.write(`  ${c.green("✓")} ${d.name}${tag}${ver}\n`);
      if (d.path) process.stdout.write(`      ${c.dim(d.path)}\n`);
    } else {
      const mark = d.required ? c.red("✗") : c.yellow("·");
      process.stdout.write(`  ${mark} ${d.name}${tag}\n`);
      process.stdout.write(`      ${c.dim("used for: " + d.usedFor)}\n`);
      process.stdout.write(`      ${c.dim("install:  " + d.install)}\n`);
      if (d.required) missingRequired += 1;
    }
  }

  if (missingRequired > 0) {
    process.stdout.write(`\n${c.red(`${missingRequired} required dependency missing.`)}\n`);
    return 1;
  }
  process.stdout.write(`\n${c.green("All required dependencies present.")}\n`);
  return 0;
}
