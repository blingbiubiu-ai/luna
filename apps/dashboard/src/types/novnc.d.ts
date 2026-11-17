/** Minimal typing for the parts of noVNC's RFB client used by the container desktop. */
declare module "@novnc/novnc" {
  export default class RFB extends EventTarget {
    constructor(target: HTMLElement, urlOrChannel: string | WebSocket, options?: { shared?: boolean; wsProtocols?: string[] });
    scaleViewport: boolean;
    resizeSession: boolean;
    viewOnly: boolean;
    focusOnClick: boolean;
    disconnect(): void;
    focus(): void;
  }
}
