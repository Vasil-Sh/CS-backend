// Parse Game object from https://www.hltv.org/matches/2385969/mouz-vs-faze-esl-pro-league-season-22

(function () {
    //console.clear();

    // Main match box
    let matchBox = document.querySelector('.standard-box.teamsBox');

    // Teams
    let team1 = matchBox.querySelector('.team1-gradient .teamName')?.innerText.trim() || '';
    let team2 = matchBox.querySelector('.team2-gradient .teamName')?.innerText.trim() || '';

    // Scores (won/lost)
    const team1ScoreText =
        matchBox.querySelector('.team1-gradient .won')?.innerText.trim() ||
        matchBox.querySelector('.team1-gradient .lost')?.innerText.trim() || null;
    const team2ScoreText =
        matchBox.querySelector('.team2-gradient .won')?.innerText.trim() ||
        matchBox.querySelector('.team2-gradient .lost')?.innerText.trim() || null;

    const score1 = team1ScoreText ? parseInt(team1ScoreText, 10) : 0;
    const score2 = team2ScoreText ? parseInt(team2ScoreText, 10) : 0;
    
    // Event info
    let eventBox = matchBox.querySelector('.timeAndEvent');
    let event = eventBox?.querySelector('.event a')?.innerText.trim() || '';
    let unixTime = eventBox?.querySelector('.time')?.getAttribute('data-unix') || '';

    // isMatchOver
    let countdownText = eventBox?.querySelector('.countdown')?.innerText.trim() || '';
    let isMatchOver = countdownText === 'Match over';
    let isLive = countdownText === 'LIVE';

    // Match format / maps info
    let mapsBox = document.querySelector('.g-grid.maps .veto-box .preformatted-text');

    // Take only the first line (e.g. "Best of 3 (LAN)")
    let matchFormat = mapsBox.innerText.split('\n')[0].trim();

    matchFormat = matchFormat
        .replace('Best of 5', 'bo5')
        .replace('Best of 3', 'bo3')
        .replace('Best of 1', 'bo1');

    let result = {
        nameTeam1: team1,
        nameTeam2: team2,
        event: event,
        unixTime: unixTime ? parseInt(unixTime, 10) : null,
        type: matchFormat,
        score1,
        score2,
        isMatchOver: isMatchOver,
        isLive: isLive
    };

    //console.log(JSON.stringify(result, null, 2));

    return result;
})();
