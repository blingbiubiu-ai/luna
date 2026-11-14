if (import.meta.main) {
  const { runWorkerCli } = await import("./cli");
  const result = await runWorkerCli(process.argv.slice(2));
  console.log(result.output ?? JSON.stringify(result));
  if (result.status === "error") process.exit(1);
}
