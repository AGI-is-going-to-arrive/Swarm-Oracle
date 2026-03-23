if (typeof globalThis.global === 'undefined') {
  globalThis.global = globalThis;
}

function unwrapModule(mod, namedKey) {
  if (namedKey && namedKey in mod) {
    return mod[namedKey];
  }
  if ('default' in mod) {
    return mod.default;
  }
  return mod;
}

const PhaserModule = await import('phaser/src/phaser-core.js');
const PhaserMathModule = await import('phaser/src/math/index.js');
const LoaderEventsModule = await import('phaser/src/loader/events/index.js');
const ContainerModule = await import('phaser/src/gameobjects/container/Container.js');
await import('phaser/src/gameobjects/container/ContainerFactory.js');
const RectangleModule = await import('phaser/src/gameobjects/shape/rectangle/Rectangle.js');
await import('phaser/src/gameobjects/shape/rectangle/RectangleFactory.js');

const Phaser = unwrapModule(PhaserModule);
const PhaserMath = unwrapModule(PhaserMathModule);
const LoaderEvents = unwrapModule(LoaderEventsModule);
const Container = unwrapModule(ContainerModule, 'Container');
const Rectangle = unwrapModule(RectangleModule, 'Rectangle');

// Fill the minimum gaps used by the current Theater runtime.
Phaser.Math = PhaserMath;
Phaser.Loader.Events = LoaderEvents;

Phaser.GameObjects.Container = Container;
Phaser.GameObjects.Rectangle = Rectangle;

export default Phaser;
