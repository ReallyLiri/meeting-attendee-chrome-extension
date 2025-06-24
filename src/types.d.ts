// Type declarations for external libraries

declare class JSZip {
  file(name: string, data: string, options?: { base64: boolean }): JSZip;
  generateAsync(options: { type: string }): Promise<Blob>;
}

declare const JSZip: {
  new (): JSZip;
};
