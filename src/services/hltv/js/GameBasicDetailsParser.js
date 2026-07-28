(function () {
    //console.clear();

    const box = document.querySelector('.standard-box.teamsBox');

    // Team names
    const teamNames = Array.from(box.querySelectorAll('.teamName')).map(el => el.innerText.trim());

    // Unix timestamp from the date div
    const dateDiv = box.querySelector('.date');
    const unixTime = dateDiv ? dateDiv.getAttribute('data-unix') : null;

    // Match type (e.g., Best of 3 (LAN))
    const matchTypeText = document.querySelector('.g-grid.maps .preformatted-text')?.innerText.split('\n')[0].trim() || null;


    var result = {
        team1: teamNames[0] || null,
        team2: teamNames[1] || null,
        unixTime: unixTime ? parseInt(unixTime, 10) : null,
        matchType: matchTypeText
    };


    //console.log(JSON.stringify(results, null, 2));

    return result;
})();
