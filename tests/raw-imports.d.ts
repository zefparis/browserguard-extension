// Allow vitest `?raw` imports of source files for static assertions.
declare module '*?raw' {
  const content: string;
  export default content;
}
