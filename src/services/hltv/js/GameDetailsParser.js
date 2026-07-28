(function () {
    let boxes = document.querySelectorAll('.mapholder');
    let gameDetails = [];

//    console.clear();

    // Team names
    const headerTeams = document.querySelectorAll('.match-page .standard-box.teamsBox .teamName');
    let nameTeam1 = headerTeams[0]?.innerText.trim() || '';
    let nameTeam2 = headerTeams[1]?.innerText.trim() || '';

    // --- PICK A WINNER PERCENTAGES (88.2%, 11.8%) ---
    const percentageWrapper = document.querySelector(
        '.analytics-pick-a-winner .pick-a-winner-percentage-wrapper'
    );

    const team1PctText =
        percentageWrapper?.querySelector('.pick-a-winner-team-percentage.team-1')
            ?.textContent.trim() || '';

    const team2PctText =
        percentageWrapper?.querySelector('.pick-a-winner-team-percentage.team-2')
            ?.textContent.trim() || '';

    const predictionPercentTeam1 = parseFloat(team1PctText.replace('%', '')) || 0; // 88.2
    const predictionPercentTeam2 = parseFloat(team2PctText.replace('%', '')) || 0; // 11.8

    // --- BETTING SECTION: provider identified by aria-label="Go to ggua" ---
    let CoefficientTeam1 = 0;
    let CoefficientTeam2 = 0;
    let BettingLink = '';

    const bettingSection = document.querySelector('.betting-section');

    if (bettingSection) {
        const providerRows = bettingSection.querySelectorAll('tr.provider');

        // Find provider where aria-label contains EXACT text "Go to ggua"
        const ggRow = Array.from(providerRows).find(row => {
            const link = row.querySelector('.betting-logo-link');
            const aria = link?.getAttribute('aria-label') || '';
            return aria.trim() === 'Go to ggua';   // strict match
        });

        if (ggRow) {
            const oddsCells = ggRow.querySelectorAll('.odds-cell');

            const team1Text = oddsCells[0]?.textContent.trim().replace(',', '.') || '0';
            const team2Text = oddsCells[1]?.textContent.trim().replace(',', '.') || '0';

            CoefficientTeam1 = parseFloat(team1Text) || 0;
            CoefficientTeam2 = parseFloat(team2Text) || 0;

            BettingLink = oddsCells[0]?.querySelector('a')?.getAttribute('href') || '';
        }
    }


    boxes.forEach(box => {
        // Map name
        let mapName = box.querySelector('.mapname')?.innerText.trim() || '';

        // Left team
        let leftBlock = box.querySelector('.results-left');
        let team1Won = leftBlock?.classList?.contains('won') || false;
        let team1Lost = leftBlock?.classList?.contains('lost') || false;
        let team1Picked = leftBlock?.classList?.contains('pick') || false;
        let team1Score = parseInt(leftBlock?.querySelector('.results-team-score')?.innerText.replace("-", "").trim() || '0', 10) || 0;

        // Right team
        let rightBlock = box.querySelector('.results-right');
        let team2Won = rightBlock?.classList?.contains('won') || false;
        let team2Lost = rightBlock?.classList?.contains('lost') || false;
        let team2Picked = rightBlock?.classList?.contains('pick') || false;
        let team2Score = parseInt(rightBlock?.querySelector('.results-team-score')?.innerText.replace("-", "").trim() || '0', 10) || 0;

        let scoreSpans = Array.from(box.querySelectorAll('.results-center-half-score span'));

        // Part1 Team1
        var spanPart1Score1 = scoreSpans[1] || 0;
        var part1Team1Score = parseInt(spanPart1Score1?.innerText || '0', 10) || 0;
        let part1Team1Side = spanPart1Score1?.classList?.contains("ct") ? "ct" :
            spanPart1Score1?.classList?.contains("t") ? "t" : "-";

        // Part1 Team2
        var spanPart1Score2 = scoreSpans[3] || 0;
        var part1Team2Score = parseInt(spanPart1Score2?.innerText || '0', 10) || 0;
        let part1Team2Side = spanPart1Score2?.classList?.contains("ct") ? "ct" :
            spanPart1Score2?.classList?.contains("t") ? "t" : "-";

        // Part2 Team1
        var spanPart2Score1 = scoreSpans[5] || 0;
        var part2Team1Score = parseInt(spanPart2Score1?.innerText || '0', 10) || 0;
        let part2Team1Side = spanPart2Score1?.classList?.contains("ct") ? "ct" :
            spanPart2Score1?.classList?.contains("t") ? "t" : "-";

        // Part2 Team2
        var spanPart2Score2 = scoreSpans[7] || 0;
        var part2Team2Score = parseInt(spanPart2Score2?.innerText || '0', 10) || 0;
        let part2Team2Side = spanPart2Score2?.classList?.contains("ct") ? "ct" :
            spanPart2Score2?.classList?.contains("t") ? "t" : "-";

        // Part3 Team1
        var spanPart3Score1 = scoreSpans[11];
        var part3Team1Score = parseInt(spanPart3Score1?.innerText || '0', 10) || 0;

        // Part3 Team2
        var spanPart3Score2 = scoreSpans[13];
        var part3Team2Score = parseInt(spanPart3Score2?.innerText || '0', 10) || 0;

        gameDetails.push({
            MapName: mapName,
            Link: '',
            GameNumber: 0,

            // Player 1
            Player1Score: team1Score,
            Player1Lost: team1Lost,
            Player1Won: team1Won,
            Player1Pick: team1Picked,
            Player1Score1: part1Team1Score,
            Player1Side1: part1Team1Side,
            Player1Score2: part2Team1Score,
            Player1Side2: part2Team1Side,
            Player1Score3: part3Team1Score,
            Player1Side3: "-",

            // Player 2
            Player2Score: team2Score,
            Player2Lost: team2Lost,
            Player2Won: team2Won,
            Player2Pick: team2Picked,
            Player2Score1: part1Team2Score,
            Player2Side1: part1Team2Side,
            Player2Score2: part2Team2Score,
            Player2Side2: part2Team2Side,
            Player2Score3: part3Team2Score,
            Player2Side3: "-"
        });
    });

    function getBase64Sync(url) {
        try {
            if (!url) return null;
            var xhr = new XMLHttpRequest();
            xhr.open('GET', url, false); // synchronous
            xhr.overrideMimeType('text/plain; charset=x-user-defined');
            xhr.send();
            if (xhr.status !== 200) return null;
            var binary = '';
            for (var i = 0; i < xhr.responseText.length; i++)
                binary += String.fromCharCode(xhr.responseText.charCodeAt(i) & 0xff);
            var base64 = btoa(binary);
            var mime = xhr.getResponseHeader('content-type')?.split(';')[0] || 'image/png';
            return 'data:' + mime + ';base64,' + base64;
        } catch (e) {
            console.log('getBase64Sync error:', e);
            return null;
        }
    }

    const teamDivs = document.querySelectorAll('.match-page .standard-box.teamsBox .team');
    const logoUrlTeam1 = teamDivs[0]?.querySelector('img.logo')?.src || '';
    const logoUrlTeam2 = teamDivs[1]?.querySelector('img.logo')?.src || '';

    let result = {
        Player1Name: nameTeam1,
        Player2Name: nameTeam2,
        PredictionPercentTeam1: predictionPercentTeam1,
        PredictionPercentTeam2: predictionPercentTeam2,
        CoefficientTeam1: CoefficientTeam1,
        CoefficientTeam2: CoefficientTeam2,
        BettingLink: BettingLink,
        LogoTeam1: getBase64Sync(logoUrlTeam1),
        LogoTeam2: getBase64Sync(logoUrlTeam2),
        gameDetails: gameDetails
    }

    //console.log(JSON.stringify(result, null, 2));

    return result;
    //return JSON.stringify(result);
})();
