class SpectorStub {
  constructor() {
    this.onCapture = {
      add() {},
    };
  }

  captureCanvas() {}

  captureNextFrame() {}

  getFps() {
    return 0;
  }

  log() {
    return '';
  }

  startCapture() {}

  stopCapture() {
    return undefined;
  }

  getResultUI() {
    return null;
  }
}

module.exports = {
  Spector: SpectorStub,
};
