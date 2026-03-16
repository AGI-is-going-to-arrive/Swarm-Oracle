// Type declarations for optional Phase 3 dependencies.
// These are dynamically imported — apps work without them installed.

declare module 'html2canvas' {
  interface Html2CanvasOptions {
    useCORS?: boolean;
    backgroundColor?: string;
    scale?: number;
    logging?: boolean;
    width?: number;
    height?: number;
  }

  function html2canvas(
    element: HTMLElement,
    options?: Html2CanvasOptions
  ): Promise<HTMLCanvasElement>;

  export default html2canvas;
}

declare module 'gif.js' {
  interface GIFOptions {
    workers?: number;
    quality?: number;
    width?: number;
    height?: number;
    workerScript?: string;
    repeat?: number;
    transparent?: number | null;
    background?: string;
  }

  interface GIFAddFrameOptions {
    copy?: boolean;
    delay?: number;
    dispose?: number;
  }

  class GIF {
    constructor(options?: GIFOptions);
    addFrame(
      image: CanvasRenderingContext2D | HTMLCanvasElement | HTMLImageElement | ImageData,
      options?: GIFAddFrameOptions
    ): void;
    on(event: 'finished', callback: (blob: Blob) => void): void;
    on(event: 'error', callback: (error: Error) => void): void;
    on(event: 'progress', callback: (progress: number) => void): void;
    render(): void;
    abort(): void;
  }

  export default GIF;
}
