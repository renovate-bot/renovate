const configParser = require('../../config');
const pkgWorker = require('../package');
const packageJson = require('./package-json');
const dockerExtract = require('../../manager/docker/extract');
const meteorExtract = require('../../manager/meteor/extract');
const nodeExtract = require('../../manager/node/extract');
const bazelExtract = require('../../manager/bazel/extract');

module.exports = {
  renovateDepType,
  getDepConfig,
};

async function renovateDepType(
  packageContent,
  config,
  packageLockParsed,
  yarnLockParsed
) {
  logger.setMeta({
    repository: config.repository,
    packageFile: config.packageFile,
    depType: config.depType,
  });
  logger.trace({ config }, `renovateDepType(packageContent, config)`);
  if (config.enabled === false) {
    logger.debug('depType is disabled');
    return [];
  }
  let deps = [];
  if (config.packageFile.endsWith('package.json')) {
    // Extract all dependencies from the package.json
    deps = await packageJson.extractDependencies(
      packageContent,
      config.depType,
      packageLockParsed,
      yarnLockParsed
    );
    if (config.lerna || config.workspaces || config.workspaceDir) {
      deps = deps.filter(
        dependency => config.monorepoPackages.indexOf(dependency.depName) === -1
      );
    }
    logger.debug(`deps length is ${deps.length}`);
    logger.debug({ deps }, `deps`);
  } else if (config.packageFile.endsWith('package.js')) {
    deps = meteorExtract.extractDependencies(packageContent);
  } else if (config.packageFile.endsWith('Dockerfile')) {
    deps = dockerExtract.extractDependencies(packageContent);
  } else if (config.packageFile.endsWith('.travis.yml')) {
    deps = nodeExtract.extractDependencies(packageContent);
  } else if (config.packageFile.endsWith('WORKSPACE')) {
    deps = bazelExtract.extractDependencies(packageContent);
  }
  deps = deps.filter(
    dependency => config.ignoreDeps.indexOf(dependency.depName) === -1
  );
  logger.debug(`filtered deps length is ${deps.length}`);
  logger.debug({ deps }, `filtered deps`);
  // Obtain full config for each dependency
  const depConfigs = deps.map(dep => module.exports.getDepConfig(config, dep));
  logger.trace({ config: depConfigs }, `depConfigs`);
  // renovateDepType can return more than one upgrade each
  const pkgWorkers = depConfigs.map(depConfig =>
    pkgWorker.renovatePackage(depConfig)
  );
  // Use Promise.all to execute npm queries in parallel
  const allUpgrades = await Promise.all(pkgWorkers);
  logger.trace({ config: allUpgrades }, `allUpgrades`);
  // Squash arrays into one
  const combinedUpgrades = [].concat(...allUpgrades);
  logger.trace({ config: combinedUpgrades }, `combinedUpgrades`);
  return combinedUpgrades;
}

function getDepConfig(depTypeConfig, dep) {
  const { depName: dependency } = dep;
  let depConfig = configParser.mergeChildConfig(depTypeConfig, dep);
  // Apply any matching package rules
  if (depConfig.packageRules) {
    logger.debug(
      { dependency, packageRules: depConfig.packageRules },
      `Checking against ${depConfig.packageRules.length} packageRules`
    );
    depConfig.packageRules.forEach(packageRule => {
      let applyRule = false;
      if (!(packageRule.packageNames || packageRule.packagePatterns)) {
        logger.debug(
          { packageRule, dependency },
          'packageRule is missing packageNames and packagePatterns so will match anything'
        );
        applyRule = true;
      } else if (
        packageRule.packageNames &&
        packageRule.packageNames.includes(depConfig.depName)
      ) {
        logger.debug(
          { dependency, packageNames: packageRule.packageNames },
          'Matched packageNames'
        );
        applyRule = true;
      } else if (packageRule.packagePatterns) {
        logger.debug({ dependency }, 'Checking against packagePatterns');
        for (const packagePattern of packageRule.packagePatterns) {
          const packageRegex = new RegExp(
            packagePattern === '^*$' || packagePattern === '*'
              ? '.*'
              : packagePattern
          );
          logger.debug(
            { dependency, packagePattern },
            'Checking against packagePattern'
          );
          if (depConfig.depName.match(packageRegex)) {
            logger.debug(
              `${depConfig.depName} matches against ${packageRegex}`
            );
            applyRule = true;
          }
        }
      }
      if (
        packageRule.excludePackageNames &&
        packageRule.excludePackageNames.includes(depConfig.depName)
      ) {
        applyRule = false;
      } else if (packageRule.excludePackagePatterns) {
        for (const packagePattern of packageRule.excludePackagePatterns) {
          const packageRegex = new RegExp(packagePattern);
          if (depConfig.depName.match(packageRegex)) {
            applyRule = false;
          }
        }
      }
      if (applyRule) {
        // Package rule config overrides any existing config
        depConfig = configParser.mergeChildConfig(depConfig, packageRule);
        delete depConfig.packageNames;
        delete depConfig.packagePatterns;
        delete depConfig.excludePackageNames;
        delete depConfig.excludePackagePatterns;
      }
    });
  }
  return configParser.filterConfig(depConfig, 'package');
}
