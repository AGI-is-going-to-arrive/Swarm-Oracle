const Phaser = require('phaser/src/phaser-core.js');

// Fill the minimum gaps used by the current Theater runtime.
Phaser.Math = require('phaser/src/math');
Phaser.Loader.Events = require('phaser/src/loader/events');

Phaser.GameObjects.Container = require('phaser/src/gameobjects/container/Container');
Phaser.GameObjects.Factories.Container = require('phaser/src/gameobjects/container/ContainerFactory');

Phaser.GameObjects.Rectangle = require('phaser/src/gameobjects/shape/rectangle/Rectangle');
Phaser.GameObjects.Factories.Rectangle = require('phaser/src/gameobjects/shape/rectangle/RectangleFactory');

module.exports = Phaser;
