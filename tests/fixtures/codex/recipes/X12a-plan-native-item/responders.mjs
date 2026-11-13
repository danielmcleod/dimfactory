import { dimFactoryResponder } from '../dim-factory-responder.mjs'

// A read-only pass: Dim Factory declines any approval (approvalPolicy never asks none).
export default dimFactoryResponder(['deny'])
