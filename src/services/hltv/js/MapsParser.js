(function () {
    //console.clear();

    const results = [];

    // 1️⃣ Map names from navigation
    const mapNameElements = document.querySelectorAll('.maps-navigation-desc');
    const mapNames = Array.from(mapNameElements).map(el => el.innerText.trim());

    // 2️⃣ Times played from "Distribution of maps played"
    const timesPlayedDiv = document.querySelector('div.graph[data-fusionchart-config*="bar2D"]');
    let timesPlayedMap = {};
    if (timesPlayedDiv) {
        const config = JSON.parse(timesPlayedDiv.getAttribute('data-fusionchart-config').replace(/&quot;/g, '"'));
        const data = config.dataSource.data || [];
        data.forEach(item => {
            timesPlayedMap[item.label.trim()] = parseFloat(item.value) || 0;
        });
    }

    // 3️⃣ T/CT wins data
    const winChartDiv = document.querySelector('div.graph[data-fusionchart-config*="mscolumn2d"]');
    let ctMap = {}, tMap = {};
    if (winChartDiv) {
        const config = JSON.parse(winChartDiv.getAttribute('data-fusionchart-config').replace(/&quot;/g, '"'));
        const categories = config.dataSource.categories[0].category.map(c => c.label.trim());
        const ctData = config.dataSource.dataset.find(s => s.seriesname.toUpperCase().includes('CT'))?.data || [];
        const tData = config.dataSource.dataset.find(s => s.seriesname.toUpperCase().includes('TERRORIST'))?.data || [];

        categories.forEach((name, i) => {
            ctMap[name] = parseFloat(ctData[i]?.value) || 0;
            tMap[name] = parseFloat(tData[i]?.value) || 0;
        });
    }

    // 4️⃣ Combine all data, using names from navigation
    mapNames.forEach(name => {
        results.push({
            id: 0,
            name,
            timesPlayed: timesPlayedMap[name] || 0,
            CtWinsPercent: ctMap[name] || 0,
            TWinsPercent: tMap[name] || 0
        });
    });


    //console.log(JSON.stringify(results, null, 2));

    return results;
})();
