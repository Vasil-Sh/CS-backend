import { describe, it, expect } from 'vitest';
import { parseTournamentMaps } from './liquipediaFeed';

describe('map scores on a tournament page', () => {
  it('reads each bracket match with its popup maps', () => {
    const html = `<div class="brkts-match">
      <div class="brkts-opponent-entry" aria-label="HEROIC"></div><div class="brkts-opponent-entry" aria-label="FaZe Clan"></div>
      <div class="brkts-popup"><div class="brkts-popup-body-game"><div>13</div><div><a title="Mirage">Mirage</a></div><div>9</div></div>
        <div class="brkts-popup-body-game"><div>10</div><div><a title="Nuke">Nuke</a></div><div>13</div></div>
        <div class="brkts-popup-body-game"><div>13</div><div><a title="Ancient">Ancient</a></div><div>7</div></div></div></div>`;
    expect(parseTournamentMaps(html)).toEqual([{ team1: 'HEROIC', team2: 'FaZe Clan', maps: [{ map: 'Mirage', score1: 13, score2: 9 }, { map: 'Nuke', score1: 10, score2: 13 }, { map: 'Ancient', score1: 13, score2: 7 }] }]);
  });
});
