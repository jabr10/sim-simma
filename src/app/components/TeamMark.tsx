import { useState } from "react";
import { teamLogoUrl } from "../teams";

interface Props {
  team: string;
  size?: "sm" | "md" | "lg";
  /** When true, show the abbreviation next to the logo. */
  showCode?: boolean;
  className?: string;
}

export default function TeamMark({ team, size = "md", showCode = true, className = "" }: Props) {
  const url = teamLogoUrl(team);
  const [failed, setFailed] = useState(false);

  return (
    <span className={`team-mark team-mark-${size} ${className}`.trim()}>
      {url && !failed ? (
        <img
          className="team-logo"
          src={url}
          alt=""
          width={size === "lg" ? 44 : size === "sm" ? 20 : 32}
          height={size === "lg" ? 44 : size === "sm" ? 20 : 32}
          loading="lazy"
          decoding="async"
          onError={() => setFailed(true)}
        />
      ) : null}
      {showCode ? <span className="team-code">{team}</span> : null}
    </span>
  );
}
