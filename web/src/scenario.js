// The default scenario. Every product is in exactly one of three sets; every
// other item must net exactly zero.
//   proportional  net output = s * p_i for one common scale s (s itself may move
//                 inside `band`; recipe choice uses `scale`)
//   exact         net output = e_i exactly
//   adjustable    net output anywhere in [min, max]  (max optional)
// Raw resources net zero too, after their extraction columns.
// Power is the one inequality row: generation * boost + extraMW >= use + fixedMW.

export const DEFAULT_SCENARIO = {
  proportional: {
    // Phase 5 of Project Assembly, per "set"
    items: {
      Desc_SpaceElevatorPart_9_C: "1000",
      Desc_SpaceElevatorPart_10_C: "1000",
      Desc_SpaceElevatorPart_12_C: "256",
      Desc_SpaceElevatorPart_11_C: "200",
    },
    scale: "3/1000", // sets per minute: one Phase 5 in 333 1/3 minutes
    band: ["27/10000", "33/10000"],
  },
  exact: {
    Desc_SingularityCell_C: "2", // Main Portal while open
    Desc_AlienPowerFuel_C: "5", // Alien Power Augmenter at +30%
  },
  adjustable: {
    // equipment, at low rates (per minute); the five favourites a little higher
    Desc_Filter_C: { min: "1", max: "2" }, // Gas Filter
    Desc_SpikedRebar_C: { min: "1", max: "2" }, // Iron Rebar
    Desc_Rebar_Stunshot_C: { min: "1", max: "2" },
    Desc_Rebar_Spreadshot_C: { min: "1", max: "2" },
    Desc_Rebar_Explosive_C: { min: "3", max: "6" },
    Desc_CartridgeStandard_C: { min: "1", max: "2" }, // Rifle Ammo
    Desc_CartridgeSmartProjectile_C: { min: "3", max: "6" }, // Homing Rifle Ammo
    Desc_CartridgeChaos_C: { min: "3", max: "6" }, // Turbo Rifle Ammo
    Desc_NobeliskExplosive_C: { min: "1", max: "2" },
    Desc_NobeliskShockwave_C: { min: "1", max: "2" }, // Pulse Nobelisk
    Desc_NobeliskCluster_C: { min: "3", max: "6" },
    Desc_NobeliskNuke_C: { min: "3", max: "6" },
    Desc_PackagedRocketFuel_C: { min: "1", max: "2" },
    Desc_PackagedIonizedFuel_C: { min: "1", max: "2" },
  },
  // Every build-gun ingredient is adjustable with net output at least what it
  // takes to rebuild the factory (machines + infrastructure) in `ratio` times
  // the Phase 5 time:  (A x)_k >= (s / ratio) * sum_j x_j * buildCost_jk  (+ min)
  selfReproduction: { enabled: true, buildGunAdjustable: true, ratio: "10" },
  // belts, pipes, rails, foundations, power per machine (see model.js)
  infrastructure: { enabled: true, channelM: "20", trackFactor: "2", foundationFactor: "2" },
  options: {
    extractionUnit: "30", // per-minute output of the reference extractor at 100%
    powerBoost: "13/10", // Alien Power Augmenter, fed
    extraMW: "500", // the Augmenter's own generation
    fixedMW: "250", // Main Portal while open
    noMixing: true, // at most one recipe per primary product
    maxOtherGenerators: 1, // generator+fuel columns outside the nuclear chain
    exemptNuclearChain: true, // uranium, plutonium and ficsonium rods don't count
    excludeConverterToResource: true,
    objective: "max", // "max": largest share of any resource's world supply; "sum": total share
  },
  columnMin: {
    "Gen:Desc_GeneratorNuclear_C:Desc_FicsoniumFuelRod_C": "1",
  },
  banned: [],
  decimals: 4, // the game allows 4 decimals of percent on a clock
};

export const cloneScenario = (s) => JSON.parse(JSON.stringify(s));
