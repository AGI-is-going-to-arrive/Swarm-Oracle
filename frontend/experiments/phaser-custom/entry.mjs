const scope =
  typeof window === 'object' && window
    ? window
    : typeof self === 'object' && self
      ? self
      : {};

if (typeof scope.global === 'undefined') {
  scope.global = scope;
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

import * as PhaserModule from 'phaser/src/phaser-core.js';
import * as PhaserMathModule from 'phaser/src/math/index.js';
import * as LoaderEventsModule from 'phaser/src/loader/events/index.js';
import * as ContainerModule from 'phaser/src/gameobjects/container/Container.js';
import 'phaser/src/gameobjects/container/ContainerFactory.js';
import * as RectangleModule from 'phaser/src/gameobjects/shape/rectangle/Rectangle.js';
import 'phaser/src/gameobjects/shape/rectangle/RectangleFactory.js';

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
