const tag = process.env.npm_config_tag ?? "latest";

if (tag !== "alpha") {
  console.error(
    'Refusing to publish prerelease software without the "alpha" dist-tag.\n' +
      "Run: npm run release:alpha",
  );
  process.exit(1);
}
