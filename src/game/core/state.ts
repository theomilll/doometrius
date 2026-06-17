import { playerIds, type GameState } from './types';
import type { Mission } from './types';
import { weapons } from '../weapons';

export function createGameState(mission: Mission): GameState {
  const players = Object.fromEntries(
    playerIds.map((id, index) => {
      const spawn = mission.playerSpawns[id];
      return [
        id,
        {
          id,
          name: index === 0 ? 'Marine One' : 'Marine Two',
          pos: { ...spawn.pos },
          angle: spawn.angle,
          viewPos: { ...spawn.pos },
          viewAngle: spawn.angle,
          bobPhase: 0,
          moveBlend: 0,
          z: 0,
          viewZ: 0,
          landingTimer: 0,
          spawn: { ...spawn.pos },
          spawnAngle: spawn.angle,
          health: 100,
          maxHealth: 100,
          armor: 25,
          ammo: 70 - weapons.stakePistol.magazineSize,
          shells: 24 - weapons.ribShotgun.magazineSize,
          magazines: {
            stakePistol: weapons.stakePistol.magazineSize,
            ribShotgun: weapons.ribShotgun.magazineSize,
          },
          weapon: 'stakePistol',
          cooldown: 0,
          fireTimer: 0,
          reloadTimer: 0,
          reloadDuration: 0,
          reloadWeapon: null,
          hurtTimer: 0,
          lastHitAngle: null,
          dryFireTimer: 0,
          faceAngryTimer: 0,
          shake: 0,
          weaponKick: 0,
          muzzleTimer: 0,
          deaths: 0,
          respawnTimer: 0,
          alive: true,
        },
      ];
    }),
  ) as GameState['players'];

  return {
    mode: 'briefing',
    time: 0,
    scores: Object.fromEntries(
      playerIds.map((id) => [
        id,
        {
          kills: 0,
          damage: 0,
          pickups: 0,
          deaths: 0,
          total: 0,
        },
      ]),
    ) as GameState['scores'],
    players,
    enemies: [],
    boss: structuredClone(mission.boss),
    pickups: structuredClone(mission.pickups),
    props: structuredClone(mission.props),
    projectiles: [],
    impacts: [],
    encounters: Object.fromEntries(
      mission.encounters.map((encounter) => [
        encounter.id,
        { id: encounter.id, triggered: false, completed: false },
      ]),
    ),
    objective: 'Click the game to aim. Either marine fires to begin.',
    objectiveTimer: 0,
    bossGateOpen: false,
    victoryTimer: 0,
    loseTimer: 0,
    nextId: 1,
  };
}

export function nextEntityId(state: GameState, prefix: string) {
  const value = `${prefix}-${state.nextId}`;
  state.nextId += 1;
  return value;
}
