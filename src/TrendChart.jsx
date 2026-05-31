// Lazy-loaded chart (keeps recharts out of the initial bundle). Used by the
// Progress (est-1RM / top weight) and Profile (body-weight) screens.
import {
  LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid,
} from "recharts";

export default function TrendChart({ data, yKey, color = "#d8ff36", height = 240, format }) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <LineChart data={data} margin={{ top: 10, right: 12, bottom: 4, left: -16 }}>
        <CartesianGrid stroke="#23262d" vertical={false} />
        <XAxis dataKey="label" tick={{ fill: "#8b9199", fontSize: 11 }} axisLine={false} tickLine={false} />
        <YAxis tick={{ fill: "#8b9199", fontSize: 11 }} axisLine={false} tickLine={false} domain={["auto", "auto"]} />
        <Tooltip
          contentStyle={{ background: "#15171b", border: "1px solid #2a2e36", borderRadius: 10, fontSize: 12 }}
          labelStyle={{ color: "#f2f4f5" }}
          formatter={format}
        />
        <Line type="monotone" dataKey={yKey} stroke={color} strokeWidth={2.5}
          dot={{ r: 3, fill: color }} activeDot={{ r: 5 }} />
      </LineChart>
    </ResponsiveContainer>
  );
}
