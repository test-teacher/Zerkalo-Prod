"use strict";
/* Tower Bloxx — только механика игры и счёт.
   Убрано: алмазы, лидерборд, темы/скины, Yandex Games SDK, мультиязычность. */

console.clear();

// Используется и для рендерера (сглаживание/pixelRatio), и для материала
// блоков (упрощённый без освещения на iOS) - меньше нагрузки на GPU,
// особенно заметно на iPhone в режиме энергосбережения, где браузер и так
// троттлится системой и любая лишняя работа увеличивает риск подвисания.
const isIOS = /iP(hone|od|ad)/.test(navigator.platform)
  || (navigator.userAgent.includes("Mac") && "ontouchend" in document);

class Stage {
  constructor() {
    this.render = function () {
      this.renderer.render(this.scene, this.camera);
    };
    this.add = function (elem) {
      this.scene.add(elem);
    };
    this.remove = function (elem) {
      this.scene.remove(elem);
    };
    this.container = document.getElementById("game");

    // На iOS сглаживание (antialias) и высокий pixel ratio ощутимо грузят
    // GPU/память - это увеличивает частоту и заметность пауз сборщика
    // мусора и подвисаний, особенно в режиме энергосбережения, где сама
    // система и так троттлит производительность браузера. pixelRatio на
    // iOS зафиксирован в 1 - жертвуем чёткостью картинки ради надёжности.
    this.renderer = new THREE.WebGLRenderer({
      antialias: !isIOS,
      alpha: false,
    });
    this.renderer.setPixelRatio(isIOS ? 1 : Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.setClearColor("#D0CBC7", 1);
    this.container.appendChild(this.renderer.domElement);

    // Safari на iOS может принудительно "убить" WebGL-контекст под давлением
    // памяти (типичная причина зависаний именно на iPhone). Без этого
    // обработчика вкладка просто застывает намертво - с ним хотя бы можно
    // корректно перезапустить игру вместо мёртвого чёрного экрана.
    this.renderer.domElement.addEventListener("webglcontextlost", (e) => {
      e.preventDefault();
      console.warn("WebGL-контекст потерян, ожидаю восстановления...");
    }, false);
    this.renderer.domElement.addEventListener("webglcontextrestored", () => {
      location.reload();
    }, false);

    this.scene = new THREE.Scene();

    let aspect = window.innerWidth / window.innerHeight;
    let d = 20;
    this.camera = new THREE.OrthographicCamera(
      -d * aspect,
      d * aspect,
      d,
      -d,
      -100,
      1000
    );
    this.camera.position.x = 2;
    this.camera.position.y = 2;
    this.camera.position.z = 2;
    this.camera.lookAt(new THREE.Vector3(0, 0, 0));

    this.light = new THREE.DirectionalLight(0xffffff, 0.5);
    this.light.position.set(0, 499, 0);
    this.scene.add(this.light);
    this.softLight = new THREE.AmbientLight(0xffffff, 0.4);
    this.scene.add(this.softLight);
    window.addEventListener("resize", () => this.onResize());
    this.onResize();
  }
  setCamera(y, speed = 0.3) {
    TweenLite.to(this.camera.position, speed, {
      y: y + 4,
      ease: Power1.easeInOut,
    });
    TweenLite.to(this.camera.lookAt, speed, { y: y, ease: Power1.easeInOut });
  }
  onResize() {
    let viewSize = 30;
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.camera.left = window.innerWidth / -viewSize;
    this.camera.right = window.innerWidth / viewSize;
    this.camera.top = window.innerHeight / viewSize;
    this.camera.bottom = window.innerHeight / -viewSize;
    this.camera.updateProjectionMatrix();
  }
}

/* Единственная цветовая палитра — тем/скинов нет. */
function generateColor(index, offset) {
  let off = index + offset;
  var r = Math.sin(0.3 * off) * 55 + 200;
  var g = Math.sin(0.3 * off + 2) * 55 + 200;
  var b = Math.sin(0.3 * off + 4) * 55 + 200;
  return new THREE.Color(r / 255, g / 255, b / 255);
}

// Общая геометрия-"заготовка" на всю игру - куб от (0,0,0) до (1,1,1),
// растягивается под нужный размер через mesh.scale вместо того, чтобы
// на каждый блок и каждую его установку рождать новую BoxGeometry.
// Раньше на одну установку блока создавалось до трёх новых геометрий
// подряд (сам блок + "поставленная" часть + "отвалившийся" кусок) - это
// была основная причина пауз сборщика мусора и подвисаний, особенно
// заметных на iOS. Освещение и материал (MeshToonMaterial) не менялись -
// затронута только геометрия, внешний вид блоков ровно тот же.
const UNIT_BOX_GEOMETRY = new THREE.BoxGeometry(1, 1, 1);
UNIT_BOX_GEOMETRY.applyMatrix(new THREE.Matrix4().makeTranslation(0.5, 0.5, 0.5));

class Block {
  constructor(block) {
    this.lastTime = performance.now();
    this.STATES = { ACTIVE: "active", STOPPED: "stopped", MISSED: "missed" };
    this.MOVE_AMOUNT = 12;
    this.dimension = { width: 0, height: 0, depth: 0 };
    this.position = { x: 0, y: 0, z: 0 };
    this.targetBlock = block;
    this.index = (this.targetBlock ? this.targetBlock.index : 0) + 1;
    this.workingPlane = this.index % 2 ? "x" : "z";
    this.workingDimension = this.index % 2 ? "width" : "depth";

    this.dimension.width = this.targetBlock
      ? this.targetBlock.dimension.width
      : 10;
    this.dimension.height = this.targetBlock
      ? this.targetBlock.dimension.height
      : 2;
    this.dimension.depth = this.targetBlock
      ? this.targetBlock.dimension.depth
      : 10;
    this.position.x = this.targetBlock ? this.targetBlock.position.x : 0;
    this.position.y = this.dimension.height * this.index;
    this.position.z = this.targetBlock ? this.targetBlock.position.z : 0;
    this.colorOffset = this.targetBlock
      ? this.targetBlock.colorOffset
      : Math.round(Math.random() * 100);

    if (!this.targetBlock) {
      this.color = 0x333344;
    } else {
      this.color = generateColor(this.index, this.colorOffset);
    }

    this.state = this.index > 1 ? this.STATES.ACTIVE : this.STATES.STOPPED;

    this.speed = -0.1 - this.index * 0.005;
    if (this.speed < -4) this.speed = -4;
    this.direction = this.speed;

    // Геометрия общая на всю игру (UNIT_BOX_GEOMETRY) - нужный размер
    // задаётся через scale меша, а не через создание новой геометрии.
    // Освещение и материал одинаковые на всех устройствах - внешний вид
    // блоков не меняется в зависимости от платформы.
    this.material = new THREE.MeshToonMaterial({ color: this.color, shading: THREE.FlatShading });
    this.mesh = new THREE.Mesh(UNIT_BOX_GEOMETRY, this.material);
    this.mesh.scale.set(this.dimension.width, this.dimension.height, this.dimension.depth);
    this.mesh.position.set(
      this.position.x,
      this.position.y + (this.state == this.STATES.ACTIVE ? 0 : 0),
      this.position.z
    );
    if (this.state == this.STATES.ACTIVE) {
      this.position[this.workingPlane] =
        Math.random() > 0.5 ? -this.MOVE_AMOUNT : this.MOVE_AMOUNT;
    }
  }
  reverseDirection() {
    this.direction = this.direction > 0 ? this.speed : Math.abs(this.speed);
  }
  place() {
    this.state = this.STATES.STOPPED;
    let overlap =
      this.targetBlock.dimension[this.workingDimension] -
      Math.abs(
        this.position[this.workingPlane] -
          this.targetBlock.position[this.workingPlane]
      );
    let blocksToReturn = {
      plane: this.workingPlane,
      direction: this.direction,
    };
    if (this.dimension[this.workingDimension] - overlap < 0.3) {
      overlap = this.dimension[this.workingDimension];
      blocksToReturn.bonus = true;
      this.position.x = this.targetBlock.position.x;
      this.position.z = this.targetBlock.position.z;
      this.dimension.width = this.targetBlock.dimension.width;
      this.dimension.depth = this.targetBlock.dimension.depth;
    }
    if (overlap > 0) {
      let choppedDimensions = {
        width: this.dimension.width,
        height: this.dimension.height,
        depth: this.dimension.depth,
      };
      choppedDimensions[this.workingDimension] -= overlap;
      this.dimension[this.workingDimension] = overlap;
      let placedMesh = new THREE.Mesh(UNIT_BOX_GEOMETRY, this.material);
      placedMesh.scale.set(this.dimension.width, this.dimension.height, this.dimension.depth);

      let choppedMesh = new THREE.Mesh(UNIT_BOX_GEOMETRY, this.material);
      choppedMesh.scale.set(choppedDimensions.width, choppedDimensions.height, choppedDimensions.depth);
      let choppedPosition = {
        x: this.position.x,
        y: this.position.y,
        z: this.position.z,
      };
      if (
        this.position[this.workingPlane] <
        this.targetBlock.position[this.workingPlane]
      ) {
        this.position[this.workingPlane] =
          this.targetBlock.position[this.workingPlane];
      } else {
        choppedPosition[this.workingPlane] += overlap;
      }
      placedMesh.position.set(
        this.position.x,
        this.position.y,
        this.position.z
      );
      choppedMesh.position.set(
        choppedPosition.x,
        choppedPosition.y,
        choppedPosition.z
      );
      blocksToReturn.placed = placedMesh;
      if (!blocksToReturn.bonus) blocksToReturn.chopped = choppedMesh;
    } else {
      this.state = this.STATES.MISSED;
    }
    this.dimension[this.workingDimension] = overlap;
    return blocksToReturn;
  }
  tick() {
    if (this.state == this.STATES.ACTIVE) {
      const currentTime = performance.now();
      let deltaTime = (currentTime - this.lastTime) / 1000;
      // Если кадр пришёл спустя большую паузу (свернули вкладку и
      // вернулись, устройство подвисло на секунду) - не даём блоку
      // одним скачком улететь далеко в сторону
      if (deltaTime > 0.1) deltaTime = 0.1;
      this.lastTime = currentTime;

      let value = this.position[this.workingPlane];
      if (value > this.MOVE_AMOUNT || value < -this.MOVE_AMOUNT) {
        this.reverseDirection();
      }

      this.position[this.workingPlane] += this.direction * deltaTime * 60;
      this.mesh.position[this.workingPlane] = this.position[this.workingPlane];
    }
  }
}

class Game {
  constructor() {
    this.isGameStopped = false;
    this.STATES = {
      LOADING: "loading",
      PLAYING: "playing",
      READY: "ready",
      ENDED: "ended",
      RESETTING: "resetting",
    };
    this.blocks = [];
    this.state = this.STATES.LOADING;
    this.stage = new Stage();
    this.mainContainer = document.getElementById("container");
    this.scoreContainer = document.getElementById("score");
    this.startButton = document.getElementById("start-button");
    this.scoreContainer.innerHTML = "0";
    this.newBlocks = new THREE.Group();
    this.placedBlocks = new THREE.Group();
    this.choppedBlocks = new THREE.Group();
    this.stage.add(this.newBlocks);
    this.stage.add(this.placedBlocks);
    this.stage.add(this.choppedBlocks);
    this.addBlock();
    this.tick();
    this.updateState(this.STATES.READY);

    document.addEventListener("keydown", (e) => {
      if (e.keyCode == 32) this.onAction();
    });
    const clickLayer = document.getElementById("gameClickLayer");
    if (clickLayer) {
      clickLayer.addEventListener("click", (e) => {
        e.stopPropagation();
        window.game.onAction();
      });
      clickLayer.addEventListener("touchstart", (e) => {
        e.preventDefault();
        e.stopPropagation();
        window.game.onAction();
      });
    }

    // Клик-слой выключается (pointer-events:none) на экране "игра
    // окончена" - чтобы кнопки под ним были кликабельны без гадания с
    // z-index. Вместо него "тап в любое место = рестарт" теперь ловит
    // сам контейнер - но сработает, только если клик НЕ был остановлен
    // кнопкой (у всех кнопок панели уже стоит stopPropagation).
    this.mainContainer.addEventListener("click", (e) => {
      if (this.state === this.STATES.ENDED) {
        this.restartGame();
      }
    });
  }
  updateState(newState) {
    for (let key in this.STATES)
      this.mainContainer.classList.remove(this.STATES[key]);
    this.mainContainer.classList.add(newState);
    this.state = newState;
  }
  onAction() {
    switch (this.state) {
      case this.STATES.READY:
        this.startGame();
        break;
      case this.STATES.PLAYING:
        this.placeBlock();
        break;
      case this.STATES.ENDED:
        this.restartGame();
        break;
    }
  }
  startGame() {
    if (this.state != this.STATES.PLAYING) {
      this.scoreContainer.innerHTML = "0";
      this.updateState(this.STATES.PLAYING);
      this.addBlock();
    }
  }
  restartGame() {
    this.updateState(this.STATES.RESETTING);
    let oldBlocks = this.placedBlocks.children;
    let removeSpeed = 0.2;
    let delayAmount = 0.02;
    for (let i = 0; i < oldBlocks.length; i++) {
      TweenLite.to(oldBlocks[i].scale, removeSpeed, {
        x: 0,
        y: 0,
        z: 0,
        delay: (oldBlocks.length - i) * delayAmount,
        ease: Power1.easeIn,
        onComplete: () => {
          this.placedBlocks.remove(oldBlocks[i]);
          // Геометрия общая на все блоки (UNIT_BOX_GEOMETRY) - её нельзя
          // освобождать, она ещё нужна остальным. Материал - свой у
          // каждого блока (разные цвета), его освобождать можно и нужно.
          if (oldBlocks[i].material) oldBlocks[i].material.dispose();
        },
      });
      TweenLite.to(oldBlocks[i].rotation, removeSpeed, {
        y: 0.5,
        delay: (oldBlocks.length - i) * delayAmount,
        ease: Power1.easeIn,
      });
    }
    let cameraMoveSpeed = removeSpeed * 2 + oldBlocks.length * delayAmount;
    this.stage.setCamera(2, cameraMoveSpeed);
    let countdown = { value: this.blocks.length - 1 };
    TweenLite.to(countdown, cameraMoveSpeed, {
      value: 0,
      onUpdate: () => {
        this.scoreContainer.innerHTML = String(Math.round(countdown.value));
      },
    });
    this.blocks = this.blocks.slice(0, 1);
    setTimeout(() => {
      this.startGame();
    }, cameraMoveSpeed * 1000);
  }
  placeBlock() {
    let currentBlock = this.blocks[this.blocks.length - 1];
    let newBlocks = currentBlock.place();
    this.newBlocks.remove(currentBlock.mesh);
    // Геометрия теперь общая на всю игру (UNIT_BOX_GEOMETRY) - её никогда
    // не освобождаем, ни здесь, ни у placed/chopped-мешей ниже.
    if (newBlocks.placed) this.placedBlocks.add(newBlocks.placed);
    if (newBlocks.chopped) {
      this.choppedBlocks.add(newBlocks.chopped);
      let positionParams = {
        y: "-=30",
        ease: Power1.easeIn,
        onComplete: () => {
          this.choppedBlocks.remove(newBlocks.chopped);
        },
      };
      let rotateRandomness = 10;
      let rotationParams = {
        delay: 0.05,
        x:
          newBlocks.plane == "z"
            ? Math.random() * rotateRandomness - rotateRandomness / 2
            : 0.1,
        z:
          newBlocks.plane == "x"
            ? Math.random() * rotateRandomness - rotateRandomness / 2
            : 0.1,
        y: Math.random() * 0.1,
      };
      if (
        newBlocks.chopped.position[newBlocks.plane] >
        newBlocks.placed.position[newBlocks.plane]
      ) {
        positionParams[newBlocks.plane] =
          "+=" + 40 * Math.abs(newBlocks.direction);
      } else {
        positionParams[newBlocks.plane] =
          "-=" + 40 * Math.abs(newBlocks.direction);
      }
      TweenLite.to(newBlocks.chopped.position, 1, positionParams);
      TweenLite.to(newBlocks.chopped.rotation, 1, rotationParams);
    }
    this.addBlock();
  }
  addBlock() {
    let lastBlock = this.blocks[this.blocks.length - 1];
    if (lastBlock && lastBlock.state == lastBlock.STATES.MISSED) {
      return this.endGame();
    }
    this.scoreContainer.innerHTML = String(this.blocks.length - 1);
    let newKidOnTheBlock = new Block(lastBlock);
    this.newBlocks.add(newKidOnTheBlock.mesh);
    this.blocks.push(newKidOnTheBlock);
    this.stage.setCamera(this.blocks.length * 2);
  }
  endGame() {
    this.updateState(this.STATES.ENDED);
    const finalScore = this.blocks.length - 2;
    const earnedPoints = finalScore > 10 ? finalScore : 0;

    // Локальное событие - собственный интерфейс игры (кнопки "Забрать
    // очки" / "×2 за рекламу") слушает именно его, чтобы знать актуальный
    // счёт прямо сейчас, не дожидаясь ответа от родительского окна
    try {
      window.dispatchEvent(new CustomEvent("towerbloxx:localgameover", {
        detail: { score: finalScore, earnedPoints }
      }));
    } catch (e) {}

    /* Сообщаем счёт наружу (родительскому окну «Зеркала дня») —
       очки начисляются в накопитель только если счёт выше 10. */
    try {
      if (window.parent && window.parent !== window) {
        window.parent.postMessage(
          { type: "towerbloxx:gameover", score: finalScore, earnedPoints: earnedPoints },
          "*"
        );
      }
    } catch (e) {}
  }
  /* Продолжение после проигрыша за алмаз - "откат на 1 тайл": последний
     (неудачный) блок просто убирается из списка, будто его не было, и
     игра возобновляется с последнего успешно установленного блока.
     Вызывается родительским окном ТОЛЬКО после того, как алмаз реально
     списан на сервере - сама игра ничего не знает про алмазы. */
  continueAfterLoss() {
    this.blocks.pop();
    this.updateState(this.STATES.PLAYING);
    this.scoreContainer.innerHTML = String(this.blocks.length - 1);
    this.addBlock();
  }
  tick() {
    if (this.isGameStopped) {
      this.stage.render();
      requestAnimationFrame(() => this.tick());
      return;
    }
    this.blocks[this.blocks.length - 1].tick();
    this.stage.render();
    requestAnimationFrame(() => this.tick());
  }
  stopGame() {
    this.isGameStopped = true;
  }
  resumeStoppedGame() {
    this.isGameStopped = false;
  }
}

let game = new Game();
window.game = game;

/* Отключение pull-to-refresh на iOS и контекстного меню — только внутри игры. */
document.addEventListener(
  "touchmove",
  (e) => {
    if (e.touches.length > 1) return;
    const touchY = e.touches[0].clientY;
    if (touchY < 20 && e.deltaY > 0) {
      e.preventDefault();
      return false;
    }
    if (e.target.closest("#game")) {
      e.preventDefault();
      return false;
    }
  },
  { passive: false }
);

window.addEventListener("scroll", () => window.scrollTo(0, 0));
document.body.style.overflow = "hidden";

document.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  return false;
});
