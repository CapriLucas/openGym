export default function BrandMark({ compact = false, className = '' }) {
  return (
    <img
      className={`brand-mark${compact ? ' compact' : ''}${className ? ` ${className}` : ''}`}
      src="./capri-gym-logo.png"
      alt="Capri Gym"
    />
  )
}
