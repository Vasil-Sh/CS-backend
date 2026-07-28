(function () {
    let boxes = document.querySelectorAll('.ranked-team.standard-box');
    let results = [];

    boxes.forEach(box => {
        let position = box.querySelector('.position')?.innerText || '';
        let name = box.querySelector('.teamLine .name')?.innerText || '';
        let pointsText = box.querySelector('.teamLine .points')?.innerText || '';
        let points = (pointsText.match(/\d+/) || [''])[0];
        let link = box.querySelector('.more a.moreLink')?.getAttribute('href') || '';

        const match = link.match(/\/team\/(\d+)\//);
        const id = match ? parseInt(match[1], 10) : null;

        results.push({
            Position: parseInt(position.replace('#', ''), 10),
            Name: name,
            Points: parseInt(points, 10),
            HltvId: id,
            DatePlayersParsed: null,
            DateGamesParsed: null,
            Comment: null
        });
    });

    return results;
})();
