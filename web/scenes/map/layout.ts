export type StudentStatus = "paid" | "debt" | "late";
export interface Room { x: number; z: number; size: number }
export interface Student { x: number; z: number; room: number; status: StudentStatus }

const ROOM_SIZE = 3.2;
const GAP = 0.8;

/** Deterministic isometric layout: rooms on a grid, students on a sub-grid inside each room. */
export function buildCenter(roomCount: number, perRoom: number): { rooms: Room[]; students: Student[] } {
  if (roomCount <= 0) return { rooms: [], students: [] };
  const cols = Math.ceil(Math.sqrt(roomCount));
  const pitch = ROOM_SIZE + GAP;
  const rooms: Room[] = [];
  const students: Student[] = [];
  const rows = Math.ceil(roomCount / cols);
  for (let r = 0; r < roomCount; r++) {
    const room: Room = {
      x: (r % cols - (cols - 1) / 2) * pitch,
      z: (Math.floor(r / cols) - (rows - 1) / 2) * pitch,
      size: ROOM_SIZE,
    };
    rooms.push(room);
    const sub = Math.max(1, Math.ceil(Math.sqrt(perRoom)));
    const step = (ROOM_SIZE - 0.8) / Math.max(1, sub - 1 || 1);
    for (let s = 0; s < perRoom; s++) {
      const idx = r * perRoom + s;
      const status = idx % 6 === 2 ? "debt" : idx % 9 === 4 ? "late" : "paid";
      const sx = sub === 1 ? 0 : (s % sub) * step - (ROOM_SIZE - 0.8) / 2;
      const sz = sub === 1 ? 0 : Math.floor(s / sub) * step - (ROOM_SIZE - 0.8) / 2;
      students.push({ x: +(room.x + sx).toFixed(4), z: +(room.z + sz).toFixed(4), room: r, status });
    }
  }
  return { rooms, students };
}
