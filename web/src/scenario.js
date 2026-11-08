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
    // examples of things you might want on the side; edit freely
    Desc_Cement_C: { min: "60", max: "120" },
    Desc_SteelPlate_C: { min: "15", max: "30" },
    Desc_ModularFrame_C: { min: "5", max: "10" },
  },
  options: {
    extractionUnit: "30", // per-minute output of the reference extractor at 100%
    powerBoost: "13/10", // Alien Power Augmenter, fed
    extraMW: "500", // the Augmenter's own generation
    fixedMW: "250", // Main Portal while open
    noMixing: true, // at most one recipe per primary product
    maxOtherGenerators: 1, // generator+fuel columns outside the nuclear chain
    exemptNuclearChain: true, // uranium, plutonium and ficsonium rods don't count
    excludeConverterToResource: true,
  },
  columnMin: {
    "Gen:Desc_GeneratorNuclear_C:Desc_FicsoniumFuelRod_C": "1",
  },
  banned: [],
  decimals: 4, // the game allows 4 decimals of percent on a clock
};

export const cloneScenario = (s) => JSON.parse(JSON.stringify(s));
