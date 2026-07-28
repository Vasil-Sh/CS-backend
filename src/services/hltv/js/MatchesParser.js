(function () {
    //console.clear();




    const results = [];


    // collect any live matches (if they appear outside sections)
    const liveWrapper = document.querySelector('.live-matches-wrapper');
    if (liveWrapper) {
        const liveMatches = liveWrapper.querySelectorAll('.match-wrapper');
        liveMatches.forEach(match => {
            const eventHeadline = match.querySelector('.match-event')?.getAttribute('data-event-headline')?.trim() || null;
            const metaElements = Array.from(match.querySelectorAll('.match-meta')).map(m => m.innerText.trim());
            const isLive = metaElements.some(m => m.toLowerCase() === 'live');
            const type = metaElements.find(m => m.toLowerCase().startsWith('bo')) || null;

            const teamNames = Array.from(match.querySelectorAll('.match-teamname')).map(el => el.innerText.trim());
            const team1 = teamNames[0] || null;
            const team2 = teamNames[1] || null;

            console.log(team1);

            const linkEl = match.querySelector('a.match-teams');
            const url = linkEl ? linkEl.getAttribute('href') : null;

            const odds = Array.from(match.querySelectorAll('.match-fixture-number')).map(el => el.innerText.trim());
            const odds1 = odds[0] ? parseFloat(odds[0].replace(',', '.')) : null;
            const odds2 = odds[1] ? parseFloat(odds[1].replace(',', '.')) : null;

            //const odds1 = odds[0] || null;
            //const odds2 = odds[1] || null;

            results.push({
                dateText: null,
                eventName: eventHeadline,
                isLive,
                type,
                team1,
                team2,
                url,
                unixTime: null,
                odds1,
                odds2
            });
        });
    }




    // Select all section containers
    const sections = document.querySelectorAll('.matches-list-section');
    sections.forEach((section, index) => {
        //sections.forEach(section => {
        //if (index >= 2) return;

        // Get the date headline (e.g. "Wednesday - 2025-10-08")
        const headline = section.querySelector('.matches-list-headline')?.innerText.trim() || null;
        console.log(headline);
        // For each match in the section
        const matches = section.querySelectorAll('.match-wrapper');

        //matches.forEach(match => {
        matches.forEach((match, index) => {
            //if (index >= 5) return;

            const eventHeadline = match.querySelector('.match-event')?.getAttribute('data-event-headline')?.trim() || null;

            const metaElements = Array.from(match.querySelectorAll('.match-meta')).map(m => m.innerText.trim());
            const isLive = metaElements.some(m => m.toLowerCase() === 'live');
            const type = metaElements.find(m => m.toLowerCase().startsWith('bo')) || null;

            const teamNames = Array.from(match.querySelectorAll('.match-teamname')).map(el => el.innerText.trim());
            const team1 = teamNames[0] || null;
            const team2 = teamNames[1] || null;
            console.log(team1 + ' - ' + team2);

            const linkEl = match.querySelector('a.match-teams');
            const url = linkEl ? linkEl.getAttribute('href') : null;

            const unixTimeAttr = match.querySelector('.match-time')?.getAttribute('data-unix');
            const unixTime = unixTimeAttr ? Number(unixTimeAttr) : null;

            // Odds (if available)
            const odds = Array.from(match.querySelectorAll('.match-fixture-number')).map(el => el.innerText.trim());
            //const odds1 = odds[0] || null;
            //const odds2 = odds[1] || null;
            const odds1 = odds[0] ? parseFloat(odds[0].replace(',', '.')) : null;
            const odds2 = odds[1] ? parseFloat(odds[1].replace(',', '.')) : null;


            if (team1 != null) {
                results.push({
                    dateText: isLive ? null : headline,
                    eventName: eventHeadline,
                    isLive,
                    type,
                    team1,
                    team2,
                    url,
                    unixTime,
                    odds1,
                    odds2
                });
            }
        });
    });



    //console.log(JSON.stringify(results, null, 2));


    return results;
})();
