const moment = require("moment");

const fs = require("fs");
const Papa = require("papaparse");
const debug = require("debug")("tkidman:dirt2-results:output");
const Handlebars = require("handlebars");
const compiled_navigation = null;

const {
  outputPath,
  hiddenPath,
  cachePath,
  templatePath
} = require("../shared");
const { leagueRef } = require("../state/league");
const locations = require("../state/constants/locations.json");
const countries = require("../state/constants/countries.json");
const vehicles = require("../state/constants/vehicles.json");
const copydir = require("copy-dir");
const { uploadFiles } = require("../awsAPI/s3");
const { updateResultsSheet } = require("../sheetsAPI/sheets");
const { processFantasyResults } = require("../fantasy/fantasyCalculator");
const resultColours = ["#76FF6A", "#faff5d", "#ffe300", "#ff5858"];
// const resultColours = ["", "", "", ""];
const buildDriverRows = event => {
  const driverRows = event.results.driverResults.map(result => {
    const driver = leagueRef.getDriver(result.name);
    let team;
    const raceNetName = driver ? driver.raceNetName : "";

    if (driver) {
      team = driver.teamId;
      if (!team) {
        debug(
          `no team found for driver: ${driver.name} - team id: ${driver.teamId}`
        );
      }
    }

    const driverRow = {};
    driverRow["POS."] = result.rank;
    driverRow.DRIVER = result.name;
    driverRow.RACENET = raceNetName;
    driverRow.TEAM = team;
    driverRow.DIVISION = result.divisionName;
    driverRow.VEHICLE = result.entry.vehicleName;
    driverRow.TOTAL = result.entry.totalTime;
    driverRow.DIFF = result.entry.totalDiff;
    driverRow.POWER_STAGE_POINTS = result.powerStagePoints;
    driverRow.OVERALL_POINTS = result.overallPoints;
    driverRow.TOTAL_POINTS = result.totalPoints;
    return driverRow;
  });
  return driverRows;
};

// eslint-disable-next-line no-unused-vars
const writeDriverCSV = (eventResults, divisionName) => {
  const driverRows = buildDriverRows(eventResults, divisionName);
  const driversCSV = Papa.unparse(driverRows);
  fs.writeFileSync(
    `./${outputPath}/${eventResults.location}-${divisionName}-driverResults.csv`,
    driversCSV
  );
};

const getAllResults = (name, events, type) => {
  return events.map(event =>
    event.results[`${type}Results`].find(result => result.name === name)
  );
};

const getHeaderLocations = events => {
  const headerLocations = events.reduce((headerLocations, event) => {
    headerLocations.push(locations[event.location].countryCode);
    return headerLocations;
  }, []);
  return headerLocations;
};

const transformForHTML = (divisionName, events, type) => {
  let division = leagueRef.divisions[divisionName];
  if (divisionName === "overall") {
    division = leagueRef.league.overall;
  }
  const headerLocations = getHeaderLocations(events);
  const lastEvent = events[events.length - 1];
  const rows = lastEvent.standings[`${type}Standings`].map(standing => {
    const movement = {
      positive: standing.positionChange > 0,
      neutral: !standing.positionChange,
      negative: standing.positionChange < 0
    };

    const results = getAllResults(standing.name, events, type);
    const row = {
      results,
      standing,
      ...movement
    };
    if (type === "driver") {
      const { driver, country, carBrand } = getDriverData(standing.name);
      return { ...row, car: carBrand, driver, country };
    }
    return row;
  });
  return {
    headerLocations,
    rows,
    showTeam: leagueRef.hasTeams,
    showCar: leagueRef.hasCars,
    title: division.displayName || divisionName,
    logo: division.logo || "jrc_round.jpg",
    divisionName
  };
};

const getDriverStandingData = (standing, events) => {
  const results = getAllResults(standing.name, events, "driver");
  const resultsTotalPoints = results.map(result => result.totalPoints);
  return {
    results,
    resultsTotalPoints,
    ...getDriverData(standing.name)
  };
};

const getTeamStandingData = (standing, events) => {
  const results = getAllResults(standing.name, events, "team");
  const resultsTotalPoints = results.map(result => result.totalPoints);
  return {
    results,
    resultsTotalPoints,
    team: standing.name
  };
};

const getDriverData = driverName => {
  const driver = leagueRef.getDriver(driverName);
  let country = countries[driver.nationality];
  if (!country) {
    debug(`no country found for ${driver.nationality} ${driver.name}`);
    country = countries["eLngRestOfWorld"];
  }
  const car = vehicles[driver.car];
  let carBrand;
  if (!car) {
    if (driver.car) {
      debug(`no car found in lookup for ${driver.car}`);
    }
  } else {
    carBrand = car.brand;
  }
  return {
    driver,
    country,
    car,
    carBrand
  };
};

const transformForDriverResultsSheet = event => {
  const header = [
    "Pos",
    "Nat",
    "Driver",
    "Car",
    "Team",
    "DNF?",
    "Total",
    "Diff",
    "PS",
    "PS Diff",
    "Points",
    "PS Points",
    "Total Points"
  ];
  const rows = event.results.driverResults.map((result, index) => {
    const { driver, country, carBrand } = getDriverData(result.name);
    let dnf = "";
    if (result.entry.disqualificationReason) {
      dnf = "DQ";
    } else if (result.entry.isDnsEntry) {
      dnf = "DNS";
    } else if (result.entry.isDnfEntry) {
      dnf = "DNF";
    }
    const row = [
      index + 1,
      country.code,
      result.name,
      carBrand,
      driver.team,
      dnf,
      `'${result.entry.totalTime}`,
      `'${result.entry.totalDiff}`,
      `'${result.entry.stageTime}`,
      `'${result.entry.stageDiff}`,
      result.overallPoints,
      result.powerStagePoints,
      result.totalPoints
    ];
    return row;
  });
  return [header, ...rows];
};

const writeDriverResultsSheet = async (event, sheetId) => {
  const rows = transformForDriverResultsSheet(event);
  await updateResultsSheet(rows, sheetId, event.location);
};

const transformForDriverStandingsSheets = events => {
  const headerLocations = getHeaderLocations(events);
  const header = [
    "Pos",
    "'+/-",
    "Nat",
    "Driver",
    "Team",
    "Division",
    "Car",
    ...headerLocations,
    "Points"
  ];
  const lastEvent = events[events.length - 1];
  const rows = lastEvent.standings.driverStandings.map(standing => {
    const {
      resultsTotalPoints,
      driver,
      country,
      carBrand
    } = getDriverStandingData(standing, events);
    const row = [
      standing.currentPosition,
      standing.positionChange,
      country.code,
      driver.name,
      driver.teamId,
      driver.division,
      carBrand,
      ...resultsTotalPoints,
      standing.totalPoints
    ];
    return row;
  });
  const allRows = [header, ...rows];
  return allRows;
};

const transformForTeamStandingsSheets = events => {
  const headerLocations = getHeaderLocations(events);
  const header = ["Pos", "'+/-", "Team", ...headerLocations, "Points"];
  const lastEvent = events[events.length - 1];
  const rows = lastEvent.standings.teamStandings.map(standing => {
    const { resultsTotalPoints, team } = getTeamStandingData(standing, events);
    const row = [
      standing.currentPosition,
      standing.positionChange,
      team,
      ...resultsTotalPoints,
      standing.totalPoints
    ];
    return row;
  });
  const allRows = [header, ...rows];
  return allRows;
};

const writeStandingsSheet = async (division, divisionName) => {
  const standingsSheetId = leagueRef.league.standingsOutputSheetId;
  const driverRows = transformForDriverStandingsSheets(division.events);
  await updateResultsSheet(
    driverRows,
    standingsSheetId,
    `${divisionName} Driver Standings`
  );
  const teamRows = transformForTeamStandingsSheets(division.events);
  await updateResultsSheet(
    teamRows,
    standingsSheetId,
    `${divisionName} Team Standings`
  );
};

const getNavigationHTML = (
  currentPage,
  currentMenu,
  links,
  headerLocations
) => {
  if (compiled_navigation == null) {
    const navigationTemplateFile = `${templatePath}/navigation.hbs`;
    const _t = fs.readFileSync(navigationTemplateFile).toString();
    this.compiled_navigation = Handlebars.compile(_t);
  }
  var _links = JSON.parse(JSON.stringify(links)); //<-- LOL javascript
  if (Object.keys(_links).indexOf(currentMenu) != -1) {
    _links[currentMenu].forEach(link => {
      link.active = link.link == currentPage;
      if (link.active) {
        _links.active = link;
        _links.active.menu = currentMenu;
      }
    });
  }
  return this.compiled_navigation({
    links: _links,
    secondary: headerLocations
  });
};

const writeHomeHTML = links => {
  const data = {
    navigation: getNavigationHTML("", "", links, null)
  };
  const homeTemplateFile = `${templatePath}/home.hbs`;
  if (!fs.existsSync(homeTemplateFile)) {
    debug("no standings html template found, returning");
    return;
  }
  const _t = fs.readFileSync(homeTemplateFile).toString();

  const template = Handlebars.compile(_t);
  const out = template(data);

  fs.writeFileSync(`./${outputPath}/website/index.html`, out);
};

const writeStandingsHTML = (divisionName, events, type, links) => {
  const data = transformForHTML(divisionName, events, type);
  data.navigation = getNavigationHTML(
    divisionName,
    type,
    links,
    data.headerLocations
  );
  data.lastUpdatedAt = moment()
    .utc()
    .format();

  const standingsTemplateFile = `${templatePath}/${type}Standings.hbs`;
  if (!fs.existsSync(standingsTemplateFile)) {
    debug("no standings html template found, returning");
    return;
  }
  const _t = fs.readFileSync(standingsTemplateFile).toString();

  const template = Handlebars.compile(_t);
  const out = template(data);

  fs.writeFileSync(
    `./${outputPath}/website/${divisionName}-${type}-standings.html`,
    out
  );
};

const writeFantasyHTML = (fantasyResults, links) => {
  const data = processFantasyResults(fantasyResults);

  const _t = fs.readFileSync(`${templatePath}/fantasyTeams.hbs`).toString();
  const team_template = Handlebars.compile(_t);
  const team_nav = getNavigationHTML("team", "fantasy", links);
  const teamData = {
    teams: data.teams,
    bestBuy: data.bestBuy,
    navigation: team_nav
  };

  var _d = fs.readFileSync(`${templatePath}/fantasyDrivers.hbs`).toString();
  var driver_template = Handlebars.compile(_d);
  const driver_nav = getNavigationHTML("driver", "fantasy", links);
  const driverData = { drivers: data.drivers, navigation: driver_nav };

  fs.writeFileSync(
    `./${outputPath}/website/team-fantasy-standings.html`,
    team_template(teamData)
  );
  fs.writeFileSync(
    `./${outputPath}/website/driver-fantasy-standings.html`,
    driver_template(driverData)
  );
};
// eslint-disable-next-line no-unused-vars
const writeStandingsCSV = (divisionName, events, type) => {
  const lastEvent = events[events.length - 1];
  const standingRows = transformForDriverStandingsSheets(events);
  const standingsCSV = Papa.unparse(standingRows);
  fs.writeFileSync(
    `./${outputPath}/${lastEvent.location}-${divisionName}-${type}Standings.csv`,
    standingsCSV
  );

  // name: satchmo, location: points, location: points, name: satchmo, total points: points, position: number,
};

const writeSheet = async (division, divisionName) => {
  const disabled = true;
  if (process.env.DIRT_SHEETS_CLIENT_SECRET && !disabled) {
    writeStandingsSheet(division, divisionName);
    for (const event of division.events) {
      await writeDriverResultsSheet(event, division.outputSheetId);
    }
  }
};
const addLinks = (links, name, group) => {
  if (Object.keys(links).indexOf(group) == -1) links[group] = [];
  links[group].push({
    link: `${name}`,
    href: `./${name}-${group}-standings.html`,
    active: false
  });
};

const timeToSeconds = time => {
  let _t = time.split(":");
  return _t[0] * 60 + parseFloat(_t[1].replace(",", "."));
};
const getStageColours = (stageTimes, benchmarks) => {
  if (!stageTimes) return undefined;
  const out = [];
  const defaultColour = benchmarks ? "#ff5858" : "";
  // const defaultColour = "";
  for (let i = 0; i < stageTimes.length; i++) {
    const time = timeToSeconds(stageTimes[i]);
    const obj = { time: stageTimes[i], colour: defaultColour };
    if (benchmarks) {
      for (let j = 0; j < benchmarks[i].length; j++) {
        if (time < timeToSeconds(benchmarks[i][j])) {
          obj.colour = resultColours[j];
          break;
        }
      }
    }
    out.push(obj);
  }
  return out;
};

const transformForDriverResultsHTML = (event, division) => {
  const divisionName = division.divisionName;
  const rows = event.results.driverResults.map((result, index) => {
    const resultDivision = leagueRef.divisions[result.divisionName];
    const { driver, country, carBrand } = getDriverData(result.name);
    if (leagueRef.league.placement)
      result.stageTimes = getStageColours(
        result.stageTimes,
        division.benchmarks
      );
    return {
      ...result,
      position: index + 1,
      car: carBrand,
      driver,
      country,
      divisionDisplayName:
        resultDivision.displayName || resultDivision.divisionName
    };
  });
  return {
    rows,
    title: division.displayName || divisionName,
    logo: division.logo || "jrc_round.jpg",
    showTeam: leagueRef.hasTeams,
    showCar: leagueRef.hasCars,
    event,
    location: locations[event.location],
    divisionName,
    stages: rows[0].stageTimes
  };
};

const writeDriverResultsHTML = (event, division, links) => {
  const data = transformForDriverResultsHTML(event, division);
  const location = locations[event.location];
  data.overall = division.divisionName === "overall";

  data.navigation = getNavigationHTML(division.divisionName, "driver", links);

  data.lastUpdatedAt = moment()
    .utc()
    .format();

  const templateFile = `${templatePath}/eventResults.hbs`;
  if (!fs.existsSync(templateFile)) {
    debug("no standings html template found, returning");
    return;
  }
  const _t = fs.readFileSync(templateFile).toString();

  const template = Handlebars.compile(_t);
  const out = template(data);

  fs.writeFileSync(
    `./${outputPath}/website/${division.divisionName}-${location.countryCode}-driver-results.html`,
    out
  );
};

const writeOutput = async () => {
  const league = leagueRef.league;
  if (league.placement) {
    writePlacementOutput();
    if (process.env.DIRT_AWS_ACCESS_KEY && league.websiteName) {
      await uploadFiles(`./${outputPath}/website`, league.websiteName);
    }
    return true;
  }
  const links = Object.keys(league.divisions).reduce((links, divisionName) => {
    if (leagueRef.hasTeams) addLinks(links, divisionName, "team");
    addLinks(links, divisionName, "driver");
    return links;
  }, {});
  addLinks(links, "overall", "team");
  addLinks(links, "overall", "driver");
  if (league.fantasy) {
    addLinks(links, "team", "fantasy");
    addLinks(links, "driver", "fantasy");
  }
  Object.keys(league.divisions).forEach(divisionName => {
    const division = league.divisions[divisionName];
    const divisionEvents = division.events;
    writeHomeHTML(links);
    writeStandingsHTML(divisionName, divisionEvents, "driver", links);
    if (leagueRef.hasTeams) {
      writeStandingsHTML(divisionName, divisionEvents, "team", links);
    }
    if (division.outputSheetId) {
      writeSheet(division, divisionName);
    }
    divisionEvents.forEach(event =>
      writeDriverResultsHTML(event, division, links)
    );
  });
  if (league.overall) {
    const overallEvents = league.overall.events;
    overallEvents.forEach(event =>
      writeDriverResultsHTML(event, league.overall, links)
    );
    writeStandingsHTML("overall", overallEvents, "driver", links);
    if (leagueRef.hasTeams) {
      writeStandingsHTML("overall", overallEvents, "team", links);
    }
    if (league.fantasy) {
      writeFantasyHTML(league.fantasy, links);
    }
  }
  writeSheet(league.overall, "Overall");
  writeJSON(league);
  if (process.env.DIRT_AWS_ACCESS_KEY && league.websiteName) {
    await uploadFiles(`./${outputPath}/website`, league.websiteName);
  }
  return true;
};

const writePlacementResultsHTML = (event, division, links) => {
  const data = transformForDriverResultsHTML(event, division);
  const location = locations[event.location];
  data.overall = division.divisionName === "overall";

  const divisionName = data.overall
    ? "overall"
    : division.divisionName.substring(0, 4).toUpperCase();
  data.navigation = getNavigationHTML(event.location, divisionName, links);

  data.lastUpdatedAt = moment()
    .utc()
    .format();

  const templateFile = `${templatePath}/placementEventResults.hbs`;
  if (!fs.existsSync(templateFile)) {
    debug("no standings html template found, returning");
    return;
  }
  const _t = fs.readFileSync(templateFile).toString();

  const template = Handlebars.compile(_t);
  const out = template(data);

  fs.writeFileSync(
    `./${outputPath}/website/${location.countryCode}-${divisionName}-driver-results.html`,
    out
  );
};

const writePlacementOutput = () => {
  const league = leagueRef.league;

  const links = Object.keys(league.divisions).reduce((links, divisionName) => {
    let division = divisionName.substring(0, 4).toUpperCase();
    if (divisionName == "jrc33") division = "overall";
    if (Object.keys(links).indexOf(division) == -1) {
      links[division] = ["grc", "usa", "nzl"].reduce((_l, loc) => {
        _l.push({
          link: loc,
          href: `./${loc}-${division}-driver-results.html`,
          active: false
        });
        return _l;
      }, []);
    }
    return links;
  }, {});

  Object.keys(league.divisions).forEach(divisionName => {
    const division = league.divisions[divisionName];
    const divisionEvents = division.events;
    divisionEvents.forEach(event =>
      writePlacementResultsHTML(event, division, links)
    );
  });
  if (league.overall) {
    const overallEvents = league.overall.events;
    overallEvents.forEach(event =>
      writePlacementResultsHTML(event, league.overall, links)
    );
  }
};

const writeJSON = eventResults => {
  fs.writeFileSync(
    `./${outputPath}/leagueResults.json`,
    JSON.stringify(eventResults, null, 2)
  );
};

const checkOutputDirs = () => {
  fs.existsSync(hiddenPath) || fs.mkdirSync(hiddenPath);
  fs.existsSync(cachePath) || fs.mkdirSync(cachePath, { recursive: true });
  fs.existsSync(outputPath) || fs.mkdirSync(outputPath, { recursive: true });
  fs.existsSync(`${outputPath}/website`) ||
    fs.mkdirSync(`${outputPath}/website`);
  copydir.sync("./assets", `${outputPath}/website/assets`);
};

module.exports = {
  writeOutput,
  checkOutputDirs,
  // tests
  buildDriverRows
};
