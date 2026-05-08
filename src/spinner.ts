import chalk from "chalk";

const FRAMES = ["|", "/", "-", "\\"];

export function startSpinner(message = "Toading"): () => void {
  if (!process.stdout.isTTY) {
    process.stdout.write(chalk.dim("🐸  " + message + "...\n"));
    return () => {};
  }
  let i = 0;
  const render = () => {
    const frame = FRAMES[i % FRAMES.length];
    process.stdout.write(`\r🐸  ${chalk.dim(message)} ${chalk.cyan(frame)}`);
    i++;
  };
  render();
  const interval = setInterval(render, 100);
  return () => {
    clearInterval(interval);
    process.stdout.write("\r\x1b[K");
  };
}
