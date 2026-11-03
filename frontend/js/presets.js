// The challenge's test targets. Positions are ICRS at `epoch`; proper motions in mas/yr
// (RA component includes cos dec). Stored here so the demo works even if the name
// resolver is unreachable.
export const PRESETS = [
  {
    id: "barnard", label: "Barnard's Star", kind: "Fastest-moving star in our sky",
    ra: 269.452077, dec: 4.693365, epoch: 2000.0, pmRa: -801.551, pmDec: 10362.394, fov: 4,
  },
  {
    id: "epsindib", label: "Epsilon Indi B", kind: "Pair of brown dwarfs orbiting a star",
    ra: 331.04383, dec: -56.78269, epoch: 2000.0, pmRa: 3982, pmDec: -2466, fov: 4,
  },
  {
    id: "wise0855", label: "WISE 0855", kind: "Coldest known brown dwarf",
    // Coordinates from the challenge brief (WISE J085510.83-071442.5, WISE epoch).
    ra: 133.795129, dec: -7.245147, epoch: 2010.5, pmRa: -8118, pmDec: 680, fov: 6,
  },
  {
    id: "rwaur", label: "RW Aurigae", kind: "Young variable star",
    ra: 76.956408, dec: 30.401408, epoch: 2000.0, pmRa: 0, pmDec: 0, fov: 4,
  },
  {
    id: "rdra", label: "R Draconis", kind: "Pulsating Mira variable",
    ra: 248.167417, dec: 66.755056, epoch: 2000.0, pmRa: 0, pmDec: 0, fov: 4,
  },
];
